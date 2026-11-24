"""
Analyse et détection en temps réel (sections 7, 8 et 9 du CDC).

Déclenchée à chaque synchronisation du téléphone (toutes les 5 s) :
  - état actuel = les 60 dernières secondes de données
  - référence adaptative : écart à l'habitude de la dernière heure (opérationnelle dès 15 min)
  - Isolation Forest + One-Class SVM entraînés sur 24 h (dès 1 h de données, réentraînés toutes les 10 min)
  - classifieur de domaines pré-entraîné (DGA, phishing, tunneling) : opérationnel immédiatement
  - analyse comportementale, métriques mobiles, prédictions
  - score de risque global pondéré (ML 30 %, comportement 30 %, URLs 20 %, mobile 20 %)

Résultats :
  - collection risk_live : dernier état de chaque terminal (mis à jour à chaque analyse)
  - collection ml_predictions : historique (1 document par minute, ou dès que la situation change)
"""
import math
import threading
import time
from collections import Counter

import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest
from sklearn.linear_model import LinearRegression
from sklearn.preprocessing import StandardScaler
from sklearn.svm import OneClassSVM

import domain_model
from db import get_db, init_db

WINDOW = "1min"
CURRENT_SECONDS = 60
SCORING_HISTORY_MINUTES = 70
TRAINING_HISTORY_HOURS = 24
MIN_TRAINING_WINDOWS = 60      # 1 h de données pour les modèles ML
MIN_BASELINE_WINDOWS = 15      # 15 min de données pour la référence adaptative
RETRAIN_SECONDS = 600
SAVE_INTERVAL_SECONDS = 60
WEIGHTS = {"ml": 0.30, "behavioral": 0.30, "url": 0.20, "mobile": 0.20}

# Features utilisées par les modèles (section 8.5 du CDC)
FEATURES = [
    "cpu_usage", "ram_usage", "battery_temperature", "cpu_temperature",
    "bytes_per_second", "dns_query_rate", "failed_dns_ratio", "unique_domains", "domain_entropy",
    "signal_dbm", "rrc_message_rate", "rrc_failure_ratio", "cell_reselection_count", "handover_count",
]
TEST_FEATURES = ["latency", "packet_loss", "dns_response_time"]
SIGNALING_COUNTS = ["rrc_message_rate", "cell_reselection_count", "handover_count",
                    "downgrade_count", "downgrade_2g_count", "out_of_service_count", "registration_denied_count"]
ALL_COLUMNS = FEATURES + TEST_FEATURES + ["storage_usage", "battery_level", "battery_drain_per_hour", "downgrade_count",
                                          "downgrade_2g_count", "out_of_service_count", "registration_denied_count"]
ZERO_FILL = ["dns_query_rate", "unique_domains"] + SIGNALING_COUNTS

# Référence adaptative : sens de l'écart surveillé, écart minimal significatif, libellé
BASELINE = {
    "cpu_usage": ("up", 5, "Utilisation CPU", "%"),
    "ram_usage": ("up", 3, "Utilisation RAM", "%"),
    "battery_temperature": ("up", 1.5, "Température batterie", "°C"),
    "cpu_temperature": ("up", 2, "Température CPU", "°C"),
    "bytes_per_second": ("up", 20000, "Trafic réseau", "o/s"),
    "dns_query_rate": ("up", 2, "Requêtes DNS", "/min"),
    "failed_dns_ratio": ("up", 0.1, "Échecs DNS", ""),
    "unique_domains": ("up", 2, "Domaines contactés", "/min"),
    "domain_entropy": ("up", 0.3, "Entropie des domaines", ""),
    "signal_dbm": ("down", 3, "Signal mobile", "dBm"),
    "latency": ("up", 20, "Latence", "ms"),
    "packet_loss": ("up", 2, "Perte de paquets", "%"),
}


# ---------------------------------------------------------------------------
# Chargement des données
# ---------------------------------------------------------------------------

def load(db, collection, device_id, since_ms, kind=None):
    query = {"device_id": device_id, "timestamp": {"$gte": since_ms}}
    if kind:
        query["kind"] = kind
    docs = list(db[collection].find(query, {"_id": 0}))
    if not docs:
        return pd.DataFrame()
    df = pd.json_normalize(docs)
    df.index = pd.to_datetime(df["timestamp"], unit="ms")
    return df.sort_index()


def num(df, col):
    if col not in df:
        return pd.Series(np.nan, index=df.index, dtype=float)
    return pd.to_numeric(df[col], errors="coerce")


def entropy(text):
    if not text:
        return 0.0
    n = len(text)
    return -sum(c / n * math.log2(c / n) for c in Counter(text).values())


def domain_reputation(domain):
    """Heuristique simple (section 7.3) : (score 0-100, raisons, entropie du plus long label)."""
    labels = domain.lower().strip(".").split(".")
    longest = max(labels, key=len)
    ent = entropy(longest)
    score, reasons = 0, []
    if len(longest) >= 10 and ent > 3.8:
        score += 30
        reasons.append("entropie élevée")
    if len(domain) > 50:
        score += 20
        reasons.append("nom très long")
    if len(longest) >= 8 and sum(ch.isdigit() for ch in longest) / len(longest) > 0.3:
        score += 15
        reasons.append("beaucoup de chiffres")
    if longest.count("-") > 3:
        score += 10
        reasons.append("nombreux tirets")
    if len(labels) > 5:
        score += 10
        reasons.append("nombreux sous-domaines")
    if labels[-1] in domain_model.SUSPICIOUS_TLDS:
        score += 20
        reasons.append("extension suspecte")
    return min(score, 100), reasons, ent


def load_all(db, device_id, since_ms):
    data = {
        "sys": load(db, "system_metrics", device_id, since_ms),
        "net": load(db, "network_metrics", device_id, since_ms, "passive"),
        "tcp": load(db, "network_metrics", device_id, since_ms, "tcp"),
        "dnstest": load(db, "network_metrics", device_id, since_ms, "dns"),
        "dns": load(db, "flow_metrics", device_id, since_ms, "dns"),
        "sig": load(db, "rrc_messages", device_id, since_ms, "android_event"),
    }
    if not data["dns"].empty:
        data["dns"]["domain_entropy"] = data["dns"]["domain"].map(lambda d: domain_reputation(d)[2])
    return data


def latest_ts(data):
    for key in ("sys", "net"):
        if not data[key].empty:
            return data[key].index.max()
    return None


# ---------------------------------------------------------------------------
# Calcul des caractéristiques (par fenêtre d'1 min ou sur la dernière minute glissante)
# ---------------------------------------------------------------------------

def compute_features(data, labels_of):
    cols = {}

    s = data["sys"]
    if not s.empty:
        k = labels_of(s.index)
        cols["cpu_usage"] = num(s, "cpu_usage").clip(lower=0).groupby(k).mean()
        cols["ram_usage"] = num(s, "ram_usage").groupby(k).mean()
        cols["storage_usage"] = num(s, "storage_usage").groupby(k).mean()
        cols["battery_temperature"] = num(s, "battery_temperature").groupby(k).mean()
        cols["cpu_temperature"] = num(s, "cpu_temperature").groupby(k).max()
        cols["battery_level"] = num(s, "battery_level").groupby(k).last()

    n = data["net"]
    if not n.empty:
        k = labels_of(n.index)
        cols["bytes_per_second"] = (num(n, "rx_bytes_per_second") + num(n, "tx_bytes_per_second")).groupby(k).mean()
        cols["signal_dbm"] = num(n, "mobile.signalDbm").groupby(k).mean()

    t = data["tcp"]
    if not t.empty:
        k = labels_of(t.index)
        cols["latency"] = num(t, "avgMs").groupby(k).mean()
        cols["packet_loss"] = num(t, "lossPercent").groupby(k).mean()

    dt = data["dnstest"]
    if not dt.empty:
        cols["dns_response_time"] = num(dt, "avgMs").groupby(labels_of(dt.index)).mean()

    d = data["dns"]
    if not d.empty:
        k = labels_of(d.index)
        cols["dns_query_rate"] = d["domain"].groupby(k).count() / (CURRENT_SECONDS / 60)
        cols["failed_dns_ratio"] = 1 - d["success"].astype(float).groupby(k).mean()
        cols["unique_domains"] = d["domain"].groupby(k).nunique()
        cols["domain_entropy"] = d["domain_entropy"].groupby(k).mean()

    g = data["sig"]
    if not g.empty:
        k = labels_of(g.index)

        def field(name):
            return g[name] if name in g else pd.Series(np.nan, index=g.index)

        out_of_service = (field("to_state") == "out_of_service").astype(float)
        denied = (field("to_registration") == "denied").astype(float)
        cols["rrc_message_rate"] = g["event"].groupby(k).count() / (CURRENT_SECONDS / 60)
        cols["rrc_failure_ratio"] = (out_of_service + denied).clip(upper=1).groupby(k).mean()
        cols["registration_denied_count"] = denied.groupby(k).sum()
        cols["handover_count"] = (field("change_type") == "handover").groupby(k).sum()
        cols["cell_reselection_count"] = (field("change_type") == "reselection").groupby(k).sum()
        cols["downgrade_count"] = (field("downgrade") == True).groupby(k).sum()  # noqa: E712
        cols["downgrade_2g_count"] = (field("to_tech") == "2G").groupby(k).sum()
        cols["out_of_service_count"] = out_of_service.groupby(k).sum()

    if not cols:
        return pd.DataFrame(columns=ALL_COLUMNS)
    return pd.DataFrame(cols).reindex(columns=ALL_COLUMNS)


def history_windows(data, before):
    """Fenêtres complètes d'1 min qui se terminent avant `before`."""
    w = compute_features(data, lambda idx: idx.floor(WINDOW))
    if w.empty:
        return w
    w = w[w.index + pd.Timedelta(WINDOW) <= before]
    w = w[w[["cpu_usage", "bytes_per_second"]].notna().any(axis=1)]
    for col in ZERO_FILL:
        w[col] = w[col].fillna(0)
    return w


DRAIN_WINDOW_MINUTES = 15   # période utilisée pour mesurer la décharge
MIN_DRAIN_MINUTES = 10      # durée minimale de décharge pour un calcul fiable


def battery_drain(sysm, last):
    """Décharge en %/h par régression sur les 15 dernières minutes hors charge (NaN si pas assez de données).
    Le niveau de batterie n'est connu qu'au pourcent près : une mesure sur 1 minute serait trop imprécise."""
    if sysm.empty or "battery_charging" not in sysm:
        return np.nan
    recent = sysm[sysm.index > last - pd.Timedelta(minutes=DRAIN_WINDOW_MINUTES)]
    charging = recent[recent["battery_charging"] == True]  # noqa: E712
    if not charging.empty:
        recent = recent[recent.index > charging.index.max()]
    level = num(recent, "battery_level").dropna()
    if len(level) < 2 or level.index[-1] - level.index[0] < pd.Timedelta(minutes=MIN_DRAIN_MINUTES):
        return np.nan
    hours = (level.index - level.index[0]).total_seconds() / 3600
    model = LinearRegression().fit(np.asarray(hours).reshape(-1, 1), level.values)
    return max(0.0, -float(model.coef_[0]))


def current_features(data, last):
    """Caractéristiques des 60 dernières secondes."""
    start = last - pd.Timedelta(seconds=CURRENT_SECONDS)
    sliced = {k: (df[(df.index > start) & (df.index <= last)] if not df.empty else df) for k, df in data.items()}
    f = compute_features(sliced, lambda idx: np.zeros(len(idx), dtype=int))
    if f.empty:
        return None, sliced
    row = f.iloc[0].copy()
    for col in ZERO_FILL:
        if pd.isna(row[col]):
            row[col] = 0
    row["battery_drain_per_hour"] = battery_drain(data["sys"], last)
    # Les tests actifs sont ponctuels : on garde la dernière valeur connue
    for col, key, field in [("latency", "tcp", "avgMs"), ("packet_loss", "tcp", "lossPercent"),
                            ("dns_response_time", "dnstest", "avgMs")]:
        if pd.isna(row[col]) and not data[key].empty:
            row[col] = num(data[key], field).dropna().iloc[-1] if num(data[key], field).notna().any() else np.nan
    return row, sliced


# ---------------------------------------------------------------------------
# Modèles ML par terminal (mis en cache, réentraînés toutes les 10 min)
# ---------------------------------------------------------------------------

_models = {}


def get_models(db, device_id, now_ms):
    cached = _models.get(device_id)
    if cached and now_ms - cached["trained_at"] < RETRAIN_SECONDS * 1000:
        return cached

    data = load_all(db, device_id, now_ms - TRAINING_HISTORY_HOURS * 3600 * 1000)
    last = latest_ts(data)
    windows = history_windows(data, last - pd.Timedelta(seconds=CURRENT_SECONDS)) if last is not None else pd.DataFrame()
    m = {"trained_at": now_ms, "n": len(windows)}

    if len(windows) >= MIN_TRAINING_WINDOWS:
        X = windows[FEATURES].astype(float)
        medians = X.median()
        X = X.fillna(medians).fillna(0)
        scaler = StandardScaler().fit(X)
        Xs = scaler.transform(X)
        iso = IsolationForest(n_estimators=200, contamination=0.02, random_state=42).fit(Xs)
        svm = OneClassSVM(nu=0.02, gamma="scale").fit(Xs)
        m.update(scaler=scaler, iso=iso, svm=svm, medians=medians,
                 iso_train=iso.score_samples(Xs), svm_train=svm.score_samples(Xs))

    _models[device_id] = m
    return m


def ml_analysis(models, current):
    if "iso" not in models:
        return None
    x = pd.DataFrame([pd.to_numeric(current[FEATURES], errors="coerce")])
    x = x.fillna(models["medians"]).fillna(0)
    xs = models["scaler"].transform(x)
    iso_score = models["iso"].score_samples(xs)[0]
    svm_score = models["svm"].score_samples(xs)[0]
    # Part des fenêtres d'entraînement plus "normales" que l'état actuel (0,5 = médiane, 1 = le plus anormal)
    rank = ((models["iso_train"] > iso_score).mean() + (models["svm_train"] > svm_score).mean()) / 2
    return {
        "score": round(max(0.0, (rank - 0.5) / 0.5) * 100, 1),
        "isolation_forest_anomaly": bool(models["iso"].predict(xs)[0] == -1),
        "one_class_svm_anomaly": bool(models["svm"].predict(xs)[0] == -1),
        "training_windows": models["n"],
    }


def baseline_analysis(recent, current):
    """Écart à l'habitude de la dernière heure (médiane et écart absolu médian)."""
    if len(recent) < MIN_BASELINE_WINDOWS:
        return None
    deviations, alerts = {}, []
    for col, (direction, min_scale, label, unit) in BASELINE.items():
        history = recent[col].dropna()
        value = current.get(col)
        if len(history) < 10 or pd.isna(value):
            continue
        median = history.median()
        mad = (history - median).abs().median()
        scale = max(1.4826 * mad, abs(median) * 0.05, min_scale)
        z = (value - median) / scale
        if direction == "down":
            z = -z
        if z > 3:
            deviations[col] = round(float(z), 1)
            if z > 4:
                alerts.append(f"{label} inhabituel(le) : {value:.1f}{unit} (habituellement {median:.1f}{unit})")
    top = max(deviations.values(), default=0)
    return {
        "score": round(min(100.0, max(0.0, (top - 3) * 20)), 1),
        "deviations": deviations,
        "alerts": alerts,
        "reference_windows": len(recent),
    }


# ---------------------------------------------------------------------------
# Domaines, comportement, mobile, prédictions
# ---------------------------------------------------------------------------

_domain_model = None
_domain_model_checked = 0.0


def get_domain_model():
    """Charge le classifieur de domaines (nouvel essai toutes les 60 s s'il n'est pas encore entraîné)."""
    global _domain_model, _domain_model_checked
    if _domain_model is None and time.time() - _domain_model_checked > 60:
        _domain_model_checked = time.time()
        _domain_model = domain_model.load_model()
    return _domain_model


def classify_domains(dns_now):
    if dns_now.empty:
        return []
    model = get_domain_model()
    results = []
    for domain in dns_now["domain"].dropna().unique():
        heuristic, reasons, _ = domain_reputation(domain)
        if model:
            p = model.predict(domain)
            results.append({"domain": domain, "class": p["class"], "score": round(p["malicious_probability"] * 100),
                            "probabilities": p["probabilities"], "whitelisted": p["whitelisted"], "reasons": reasons})
        else:
            results.append({"domain": domain, "class": "suspect" if heuristic >= 40 else "benign",
                            "score": heuristic, "reasons": reasons})
    return results


def behavioral_analysis(history, current, dns_now, classified):
    score, alerts = 0, []

    def median(col):
        return history[col].median() if len(history) else np.nan

    rate, rate_med = current["dns_query_rate"], median("dns_query_rate")
    if rate > 30 and (np.isnan(rate_med) or rate > 3 * max(rate_med, 1)):
        score += 25
        alerts.append(f"Rafale de requêtes DNS ({rate:.0f}/min)")

    if rate >= 3 and current["failed_dns_ratio"] > 0.3:
        score += 25
        alerts.append(f"Taux d'échec DNS élevé ({current['failed_dns_ratio'] * 100:.0f} %)")

    bps, bps_med = current["bytes_per_second"], median("bytes_per_second")
    if not pd.isna(bps) and not np.isnan(bps_med) and bps_med > 0 and bps > 5 * bps_med and bps > 500_000:
        score += 20
        alerts.append(f"Pic de trafic inhabituel ({bps / 1e6:.1f} Mo/s)")

    if not dns_now.empty:
        counts = dns_now["domain"].value_counts()
        if counts.iloc[0] > 20:
            score += 20
            alerts.append(f"Requêtes répétitives vers {counts.index[0]} ({counts.iloc[0]}/min)")

    by_class = Counter(r["class"] for r in classified)
    long_names = int((dns_now["domain"].str.len() > 60).sum()) if not dns_now.empty else 0
    txt_ratio = (dns_now["query_type"] == "TXT").mean() if not dns_now.empty and "query_type" in dns_now else 0
    if by_class["tunneling"] >= 1 or long_names >= 3 or (len(dns_now) >= 5 and txt_ratio > 0.3):
        score += 30
        alerts.append(f"Suspicion de DNS tunneling ({max(by_class['tunneling'], long_names)} domaine(s))")

    high_entropy = sum(1 for r in classified if domain_reputation(r["domain"])[2] > 3.8)
    if by_class["dga"] >= 3 or high_entropy >= 5:
        score += 25
        alerts.append(f"Domaines générés automatiquement (DGA) : {max(by_class['dga'], high_entropy)}")

    phishing = [r["domain"] for r in classified if r["class"] == "phishing"]
    if phishing:
        score += 25
        alerts.append(f"Hameçonnage probable : {', '.join(phishing[:3])}")

    # Signalisation cellulaire (section 7.5)
    if current["downgrade_2g_count"] > 0:
        score += 30
        alerts.append("Rétrogradation forcée vers la 2G (indicateur de fausse station de base)")
    elif current["downgrade_count"] > 0:
        score += 10
        alerts.append("Rétrogradation de technologie réseau (5G/4G vers inférieure)")

    changes = current["handover_count"] + current["cell_reselection_count"]
    if changes >= 4:
        score += 20
        alerts.append(f"Changements de cellule anormalement fréquents ({changes:.0f}/min)")

    if current["out_of_service_count"] > 0:
        score += 10
        alerts.append("Perte de service réseau mobile")

    if current["registration_denied_count"] > 0:
        score += 15
        alerts.append("Enregistrement refusé par le réseau mobile")

    return min(score, 100), alerts


def url_analysis(classified):
    suspicious = sorted((r for r in classified if r["score"] >= 50), key=lambda r: r["score"], reverse=True)
    return (suspicious[0]["score"] if suspicious else 0), suspicious[:10]


def mobile_analysis(current):
    score, alerts = 0, []
    rules = [
        ("cpu_usage", lambda v: v > 90, 25, "Saturation CPU ({:.0f} %)"),
        ("battery_temperature", lambda v: v > 45, 25, "Surchauffe batterie ({:.1f} °C)"),
        ("cpu_temperature", lambda v: v > 80, 20, "Surchauffe CPU ({:.1f} °C)"),
        ("ram_usage", lambda v: v > 90, 15, "Saturation RAM ({:.0f} %)"),
        ("battery_drain_per_hour", lambda v: v > 20, 15, "Décharge batterie excessive ({:.0f} %/h)"),
        ("signal_dbm", lambda v: v < -110, 10, "Signal mobile très faible ({:.0f} dBm)"),
        ("packet_loss", lambda v: v > 10, 15, "Perte de paquets ({:.0f} %)"),
        ("latency", lambda v: v > 300, 10, "Latence élevée ({:.0f} ms)"),
    ]
    for col, condition, weight, message in rules:
        value = current.get(col)
        if not pd.isna(value) and condition(value):
            score += weight
            alerts.append(message.format(value))
    return min(score, 100), alerts


def predictions(sysm, history):
    out = {"battery_drain_per_hour": None, "battery_hours_left": None,
           "signal_dbm_30min": None, "signal_loss_risk": None}

    # Batterie : régression linéaire sur la dernière période de décharge
    if not sysm.empty and "battery_charging" in sysm:
        recent = sysm
        charging = recent[recent["battery_charging"] == True]  # noqa: E712
        if not charging.empty:
            recent = recent[recent.index > charging.index.max()]
        level = num(recent, "battery_level").dropna()
        if len(level) >= 10:
            hours = (level.index - level.index[0]).total_seconds() / 3600
            model = LinearRegression().fit(np.asarray(hours).reshape(-1, 1), level.values)
            drain = -float(model.coef_[0])
            out["battery_drain_per_hour"] = round(drain, 2)
            if drain > 0.1:
                out["battery_hours_left"] = round(float(level.iloc[-1]) / drain, 1)

    # Signal mobile : tendance des 30 dernières minutes, projetée à +30 min
    signal = history["signal_dbm"].dropna().tail(30) if not history.empty else pd.Series(dtype=float)
    if len(signal) >= 5:
        x = np.arange(len(signal)).reshape(-1, 1)
        model = LinearRegression().fit(x, signal.values)
        predicted = float(model.predict([[len(signal) - 1 + 30]])[0])
        out["signal_dbm_30min"] = round(predicted, 1)
        out["signal_loss_risk"] = predicted < -110
    return out


def risk_class(score):
    if score < 30:
        return "Normal"
    if score < 55:
        return "Anomalie réseau"
    if score < 75:
        return "Menace potentielle"
    return "Menace confirmée"


def clean(value):
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return None
    if isinstance(value, np.generic):
        return clean(value.item())
    return value


# ---------------------------------------------------------------------------
# Analyse d'un terminal
# ---------------------------------------------------------------------------

_last_saved = {}


def analyze_device(db, device_id, now_ms=None):
    now_ms = now_ms or int(time.time() * 1000)
    data = load_all(db, device_id, now_ms - SCORING_HISTORY_MINUTES * 60 * 1000)
    last = latest_ts(data)
    if last is None:
        return None
    current, sliced = current_features(data, last)
    if current is None:
        return None
    window_start = last - pd.Timedelta(seconds=CURRENT_SECONDS)
    history = history_windows(data, window_start)

    models = get_models(db, device_id, now_ms)
    ml = ml_analysis(models, current)
    baseline = baseline_analysis(history.tail(60), current)
    classified = classify_domains(sliced["dns"])
    behavioral_score, behavioral_alerts = behavioral_analysis(history, current, sliced["dns"], classified)
    url_score, suspicious = url_analysis(classified)
    mobile_score, mobile_alerts = mobile_analysis(current)

    # Composante ML : modèles entraînés + référence adaptative (ou ce qui est disponible)
    if ml and baseline:
        ml_component = 0.5 * ml["score"] + 0.5 * baseline["score"]
    elif ml:
        ml_component = ml["score"]
    elif baseline:
        ml_component = baseline["score"]
    else:
        ml_component = 0.0

    components = {"ml": round(ml_component, 1), "behavioral": behavioral_score, "url": url_score, "mobile": mobile_score}
    risk = round(sum(components[k] * WEIGHTS[k] for k in WEIGHTS), 1)

    alerts = []
    if ml and ml["isolation_forest_anomaly"] and ml["one_class_svm_anomaly"]:
        alerts.append("Comportement inhabituel détecté par les modèles ML")
    if baseline:
        alerts += baseline["alerts"]
    alerts += behavioral_alerts + mobile_alerts
    if suspicious:
        alerts.append(f"{len(suspicious)} domaine(s) suspect(s)")

    doc = {
        "device_id": device_id,
        "local_id": f"srv-{now_ms}",
        "kind": "risk",
        "timestamp": now_ms,
        "window_start": int(window_start.timestamp() * 1000),
        "window_end": int(last.timestamp() * 1000),
        "risk_score": risk,
        "risk_class": risk_class(risk),
        "components": components,
        "ml": ml or {"status": f"apprentissage en cours ({models['n']}/{MIN_TRAINING_WINDOWS} min de données)"},
        "baseline": baseline or {"status": f"référence en cours ({len(history)}/{MIN_BASELINE_WINDOWS} min de données)"},
        "domain_model": "pré-entraîné" if get_domain_model() else "non entraîné (heuristique)",
        "alerts": alerts,
        "suspicious_domains": suspicious,
        "predictions": predictions(data["sys"], history),
        "features": {col: clean(current.get(col))
                     for col in FEATURES + TEST_FEATURES + SIGNALING_COUNTS + ["battery_drain_per_hour"]},
    }

    # État en direct (toujours) + historique (1 par minute, ou dès que la situation change)
    db.risk_live.replace_one({"_id": device_id}, doc, upsert=True)
    previous = _last_saved.get(device_id)
    if (previous is None or now_ms - previous["time"] >= SAVE_INTERVAL_SECONDS * 1000
            or previous["class"] != doc["risk_class"] or previous["alerts"] != set(alerts)):
        db.ml_predictions.insert_one(dict(doc))
        _last_saved[device_id] = {"time": now_ms, "class": doc["risk_class"], "alerts": set(alerts)}
    return doc


def run_all():
    db = get_db()
    results = []
    for device_id in db.devices.distinct("_id"):
        try:
            doc = analyze_device(db, device_id)
            if doc:
                results.append(doc)
        except Exception as e:
            print(f"[analyse] {device_id} : erreur {e}", flush=True)
    return results


# ---------------------------------------------------------------------------
# Analyse en temps réel : file d'attente traitée par un thread de fond
# ---------------------------------------------------------------------------

_pending = set()
_lock = threading.Lock()
_event = threading.Event()


def request_analysis(device_id):
    """Appelée après chaque synchronisation : l'analyse se fait sans ralentir la réponse au téléphone."""
    with _lock:
        _pending.add(device_id)
    _event.set()


def _worker():
    db = get_db()
    while True:
        _event.wait()
        _event.clear()
        with _lock:
            devices = list(_pending)
            _pending.clear()
        for device_id in devices:
            try:
                doc = analyze_device(db, device_id)
                if doc and doc["risk_class"] != "Normal":
                    print(f"[analyse] {device_id} : {doc['risk_score']} ({doc['risk_class']}) - "
                          f"{'; '.join(doc['alerts'])}", flush=True)
            except Exception as e:
                print(f"[analyse] {device_id} : erreur {e}", flush=True)


def start_worker():
    threading.Thread(target=_worker, daemon=True).start()


if __name__ == "__main__":
    init_db()
    for r in run_all():
        print(f"[analyse] {r['device_id']} : score {r['risk_score']} ({r['risk_class']}) - {r['alerts']}")