"""API REST NetData : authentification JWT, association des téléphones et synchronisation des données."""
import hashlib
import json
import os
import secrets
import time
from datetime import datetime, timedelta, timezone
from functools import wraps

import pandas as pd
from flask import Flask, Response, jsonify, request, send_file
from flask_jwt_extended import (
    JWTManager,
    create_access_token,
    create_refresh_token,
    get_jwt,
    get_jwt_identity,
    jwt_required,
    verify_jwt_in_request,
)
from pymongo.errors import BulkWriteError
from werkzeug.security import check_password_hash

from analysis import request_analysis, run_all, start_worker
from db import SYNC_COLLECTIONS, get_db, init_db

PAIRING_CODE_MINUTES = 10
PAIRING_MAX_FAILURES = 10          # essais ratés autorisés par adresse IP...
PAIRING_FAILURE_WINDOW = 600       # ...sur 10 minutes

# Distribution de l'application (APK publié depuis le dashboard)
RELEASES_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "releases")
APK_PATH = os.path.join(RELEASES_DIR, "netdata.apk")
RELEASE_META_PATH = os.path.join(RELEASES_DIR, "release.json")

app = Flask(__name__)
app.config["JWT_SECRET_KEY"] = os.environ["JWT_SECRET_KEY"]
app.config["JWT_ACCESS_TOKEN_EXPIRES"] = timedelta(hours=1)
app.config["JWT_REFRESH_TOKEN_EXPIRES"] = timedelta(days=30)
app.config["MAX_CONTENT_LENGTH"] = 200 * 1024 * 1024  # 200 Mo par requête (envoi de l'APK)

jwt = JWTManager(app)
init_db()
start_worker()  # analyse en temps réel, déclenchée à chaque synchronisation


# ---------------------------------------------------------------------------
# Jetons : administrateur (compte utilisateur) ou téléphone (association par code)
# ---------------------------------------------------------------------------

def is_device_token(claims):
    return claims.get("role") == "device"


def device_tokens(device_id):
    """Jetons d'un téléphone : le jeton de rafraîchissement n'expire pas, mais le téléphone peut être révoqué."""
    identity = f"device:{device_id}"
    claims = {"role": "device", "device_id": device_id}
    return {
        "access_token": create_access_token(identity=identity, additional_claims=claims),
        "refresh_token": create_refresh_token(identity=identity, additional_claims=claims, expires_delta=False),
    }


def device_revoked(device_id):
    device = get_db().devices.find_one({"_id": device_id}, {"revoked": 1})
    return device is None or device.get("revoked", False)


def admin_required(fn):
    """Route réservée aux comptes utilisateurs (dashboard, consultation) : refusée aux jetons de téléphone."""
    @wraps(fn)
    def wrapper(*args, **kwargs):
        verify_jwt_in_request()
        if is_device_token(get_jwt()):
            return {"error": "Accès réservé à l'administrateur"}, 403
        return fn(*args, **kwargs)
    return wrapper


# Limitation des essais de code d'association (protection contre les essais au hasard)
_pairing_failures = {}


def client_ip():
    return request.headers.get("X-Forwarded-For", request.remote_addr or "").split(",")[0].strip()


def too_many_failures(ip):
    now = time.time()
    attempts = [t for t in _pairing_failures.get(ip, []) if now - t < PAIRING_FAILURE_WINDOW]
    _pairing_failures[ip] = attempts
    return len(attempts) >= PAIRING_MAX_FAILURES


# ---------------------------------------------------------------------------
# Authentification
# ---------------------------------------------------------------------------

@app.get("/")
def dashboard():
    """Dashboard web de supervision (fichiers du dossier static/)."""
    return app.send_static_file("index.html")


@app.get("/install")
def install_page():
    """Page publique d'installation de l'app (cible du QR code)."""
    return app.send_static_file("install.html")


# ---------------------------------------------------------------------------
# Distribution de l'application
# ---------------------------------------------------------------------------

def release_info():
    if not (os.path.exists(APK_PATH) and os.path.exists(RELEASE_META_PATH)):
        return None
    with open(RELEASE_META_PATH, encoding="utf-8") as f:
        return json.load(f)


@app.get("/api/app/latest")
def app_latest():
    """Version publiée de l'app (publique : affichée sur la page d'installation)."""
    info = release_info()
    if not info:
        return {"error": "Aucune version publiée"}, 404
    return {**info, "download_url": "/install/netdata.apk"}


@app.get("/install/netdata.apk")
def app_download():
    info = release_info()
    if not info:
        return {"error": "Aucune version publiée"}, 404
    return send_file(APK_PATH, mimetype="application/vnd.android.package-archive",
                     as_attachment=True, download_name=f"netdata-{info['version']}.apk")


@app.post("/api/app/upload")
@admin_required
def app_upload():
    """Publie une nouvelle version de l'APK (formulaire : fichier « apk » + champ « version »)."""
    apk = request.files.get("apk")
    version = (request.form.get("version") or "").strip()[:20]
    if not apk or not apk.filename.lower().endswith(".apk"):
        return {"error": "Fichier .apk manquant"}, 400
    if not version:
        return {"error": "Numéro de version manquant"}, 400

    os.makedirs(RELEASES_DIR, exist_ok=True)
    tmp_path = APK_PATH + ".tmp"
    apk.save(tmp_path)

    with open(tmp_path, "rb") as f:
        if f.read(2) != b"PK":  # un APK est une archive ZIP
            os.remove(tmp_path)
            return {"error": "Ce fichier n'est pas un APK valide"}, 400

    sha256 = hashlib.sha256()
    with open(tmp_path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            sha256.update(chunk)

    os.replace(tmp_path, APK_PATH)  # remplacement atomique : jamais d'APK à moitié écrit
    info = {
        "version": version,
        "size": os.path.getsize(APK_PATH),
        "sha256": sha256.hexdigest(),
        "uploaded_at": datetime.now(timezone.utc).isoformat(),
        "uploaded_by": get_jwt_identity(),
    }
    with open(RELEASE_META_PATH, "w", encoding="utf-8") as f:
        json.dump(info, f)
    return info


@app.get("/api/health")
def health():
    get_db().command("ping")
    return {"status": "ok"}


@app.post("/api/auth/login")
def login():
    body = request.get_json(silent=True) or {}
    user = get_db().users.find_one({"username": body.get("username")})
    if not user or not check_password_hash(user["password_hash"], body.get("password", "")):
        return {"error": "Identifiants invalides"}, 401

    identity = user["username"]
    claims = {"role": "user"}
    return {
        "access_token": create_access_token(identity=identity, additional_claims=claims),
        "refresh_token": create_refresh_token(identity=identity, additional_claims=claims),
    }


@app.post("/api/auth/refresh")
@jwt_required(refresh=True)
def refresh():
    claims = get_jwt()
    if is_device_token(claims):
        if device_revoked(claims["device_id"]):
            return {"error": "Téléphone révoqué"}, 401
        return {"access_token": create_access_token(
            identity=get_jwt_identity(),
            additional_claims={"role": "device", "device_id": claims["device_id"]},
        )}
    return {"access_token": create_access_token(identity=get_jwt_identity(), additional_claims={"role": "user"})}


# ---------------------------------------------------------------------------
# Association des téléphones par code
# ---------------------------------------------------------------------------

@app.post("/api/pairing/code")
@admin_required
def pairing_code():
    """Génère un code à 6 chiffres, valable 10 minutes et utilisable une seule fois."""
    body = request.get_json(silent=True) or {}
    db = get_db()
    now = datetime.now(timezone.utc)

    code = f"{secrets.randbelow(1_000_000):06d}"
    while db.pairing_codes.find_one({"_id": code}):
        code = f"{secrets.randbelow(1_000_000):06d}"

    expires = now + timedelta(minutes=PAIRING_CODE_MINUTES)
    db.pairing_codes.insert_one({
        "_id": code,
        "name": (str(body.get("name") or "").strip()[:60]) or None,
        "created_by": get_jwt_identity(),
        "created_at": now,
        "expires_at": expires,
        "used": False,
    })
    return {"code": code, "expires_at": expires.isoformat(), "expires_in": PAIRING_CODE_MINUTES * 60}


@app.post("/api/pairing/pair")
def pair():
    """Le téléphone échange un code valide contre ses propres jetons."""
    ip = client_ip()
    if too_many_failures(ip):
        return {"error": "Trop d'essais, réessaie dans quelques minutes"}, 429

    body = request.get_json(silent=True) or {}
    code = str(body.get("code", "")).strip()
    device_id = body.get("device_id")
    if not isinstance(device_id, str) or not 0 < len(device_id) <= 100:
        return {"error": "device_id manquant"}, 400

    db = get_db()
    now = datetime.now(timezone.utc)
    entry = db.pairing_codes.find_one_and_update(
        {"_id": code, "used": False, "expires_at": {"$gt": now}},
        {"$set": {"used": True, "used_by": device_id, "used_at": now}},
    )
    if not entry:
        _pairing_failures.setdefault(ip, []).append(time.time())
        return {"error": "Code invalide ou expiré"}, 400

    info = body.get("device_info") or {}
    name = entry.get("name") or " ".join(filter(None, [info.get("manufacturer"), info.get("model")])) or device_id
    db.devices.update_one(
        {"_id": device_id},
        {
            "$set": {"name": name, "info": info, "revoked": False, "paired_at": now},
            "$setOnInsert": {"first_seen": now},
        },
        upsert=True,
    )
    return {**device_tokens(device_id), "device_name": name}


# ---------------------------------------------------------------------------
# Synchronisation
# ---------------------------------------------------------------------------

@app.post("/api/sync")
@jwt_required()
def sync():
    """
    Reçoit les enregistrements de la base locale du téléphone.
    Format : {"device_id": "...", "device_info": {...},
              "records": {"system_metrics": [{"local_id": 1, "timestamp": 0, "kind": null, "data": {...}}]}}
    Retourne les local_id acceptés par table, pour que le mobile les marque comme synchronisés.
    """
    body = request.get_json(silent=True) or {}
    device_id = body.get("device_id")
    if not isinstance(device_id, str) or not device_id:
        return {"error": "device_id manquant"}, 400

    claims = get_jwt()
    if is_device_token(claims):
        if device_id != claims["device_id"]:
            return {"error": "Ce téléphone ne peut envoyer que ses propres données"}, 403
        if device_revoked(device_id):
            return {"error": "Téléphone révoqué"}, 401

    db = get_db()
    now = datetime.now(timezone.utc)

    update = {"last_sync": now, "user": get_jwt_identity()}
    if body.get("device_info"):  # n'efface pas les infos connues si le téléphone n'en envoie pas
        update["info"] = body["device_info"]
    db.devices.update_one({"_id": device_id}, {"$set": update, "$setOnInsert": {"first_seen": now}}, upsert=True)

    accepted = {}
    for table, records in (body.get("records") or {}).items():
        if table not in SYNC_COLLECTIONS or not isinstance(records, list):
            continue

        docs = []
        for r in records:
            if not isinstance(r, dict) or not isinstance(r.get("data"), dict):
                continue
            data = {k: v for k, v in r["data"].items() if k != "_id"}
            docs.append({
                **data,
                "device_id": device_id,
                "local_id": r.get("local_id"),
                "timestamp": r.get("timestamp"),
                "kind": r.get("kind"),
                "received_at": now,
            })

        if docs:
            try:
                db[table].insert_many(docs, ordered=False)
            except BulkWriteError as e:
                # 11000 = doublon déjà reçu lors d'une synchronisation précédente : ignoré
                if any(err["code"] != 11000 for err in e.details["writeErrors"]):
                    raise
        accepted[table] = [d["local_id"] for d in docs]

    request_analysis(device_id)
    # Dernier état de risque connu, renvoyé au téléphone (affichage + notification)
    risk = db.risk_live.find_one({"_id": device_id}, {"_id": 0})
    return {"accepted": accepted, "risk": risk}


# ---------------------------------------------------------------------------
# Gestion des téléphones et consultation (administrateur)
# ---------------------------------------------------------------------------

@app.get("/api/devices")
@admin_required
def devices():
    db = get_db()
    fields = {"name": 1, "info": 1, "last_sync": 1, "first_seen": 1, "paired_at": 1, "revoked": 1}
    risks = {r["_id"]: r for r in db.risk_live.find({}, {"risk_score": 1, "risk_class": 1, "timestamp": 1, "alerts": 1})}
    result = []
    for device in db.devices.find({}, fields).sort("last_sync", -1):
        risk = risks.get(device["_id"])
        device["risk"] = {k: risk.get(k) for k in ("risk_score", "risk_class", "timestamp", "alerts")} if risk else None
        result.append(device)
    return jsonify(result)


@app.patch("/api/devices/<device_id>")
@admin_required
def rename_device(device_id):
    name = str((request.get_json(silent=True) or {}).get("name") or "").strip()[:60]
    if not name:
        return {"error": "Nom manquant"}, 400
    result = get_db().devices.update_one({"_id": device_id}, {"$set": {"name": name}})
    if result.matched_count == 0:
        return {"error": "Téléphone inconnu"}, 404
    return {"device_id": device_id, "name": name}


@app.post("/api/devices/<device_id>/revoke")
@admin_required
def revoke_device(device_id):
    result = get_db().devices.update_one({"_id": device_id}, {"$set": {"revoked": True}})
    if result.matched_count == 0:
        return {"error": "Téléphone inconnu"}, 404
    return {"device_id": device_id, "revoked": True}


def data_query():
    """Filtres communs : device_id, kind (une ou plusieurs valeurs séparées par des virgules), since / until (ms)."""
    query = {}
    device_id = request.args.get("device_id")
    if device_id:
        query["device_id"] = device_id
    kind = request.args.get("kind")
    if kind:
        kinds = [k for k in kind.split(",") if k]
        query["kind"] = kinds[0] if len(kinds) == 1 else {"$in": kinds}
    since = request.args.get("since", type=int)
    until = request.args.get("until", type=int)
    if since or until:
        query["timestamp"] = {**({"$gte": since} if since else {}), **({"$lte": until} if until else {})}
    return query


@app.get("/api/data/<collection>")
@admin_required
def data(collection):
    if collection not in SYNC_COLLECTIONS:
        return {"error": "Collection inconnue"}, 404
    limit = min(request.args.get("limit", 100, type=int), 2000)
    docs = get_db()[collection].find(data_query(), {"_id": 0}).sort("timestamp", -1).limit(limit)
    return jsonify(list(docs))


@app.get("/api/export/<collection>")
@admin_required
def export_csv(collection):
    """Export CSV (séparateur ; et encodage UTF-8 avec BOM pour une ouverture directe dans Excel)."""
    if collection not in SYNC_COLLECTIONS:
        return {"error": "Collection inconnue"}, 404
    docs = list(get_db()[collection].find(data_query(), {"_id": 0}).sort("timestamp", 1).limit(100_000))
    df = pd.json_normalize(docs) if docs else pd.DataFrame()
    if "timestamp" in df:
        dates = pd.to_datetime(pd.to_numeric(df["timestamp"], errors="coerce"), unit="ms", utc=True)
        df.insert(0, "date_utc", dates.dt.strftime("%Y-%m-%d %H:%M:%S"))
    csv = "﻿" + df.to_csv(index=False, sep=";")
    return Response(csv, mimetype="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="{collection}.csv"'})


@app.post("/api/analysis/run")
@admin_required
def analysis_run():
    """Lance immédiatement l'analyse de tous les terminaux."""
    return jsonify({"results": run_all()})


@app.get("/api/analysis/latest")
@admin_required
def analysis_latest():
    """État de risque en direct (d'un terminal précis si device_id est fourni)."""
    query = {}
    device_id = request.args.get("device_id")
    if device_id:
        query["_id"] = device_id
    doc = get_db().risk_live.find_one(query, {"_id": 0}, sort=[("timestamp", -1)])
    if not doc:
        return {"error": "Aucune analyse disponible"}, 404
    return jsonify(doc)