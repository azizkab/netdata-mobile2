"""
Classifieur de domaines pré-entraîné (sections 7.3 et 8.4 du CDC).
Classes : benign / dga (domaines générés par un malware) / phishing / tunneling (exfiltration DNS).

Entraînement (une seule fois, environ 2 à 5 minutes) :
    docker compose exec backend python domain_model.py

Données d'entraînement :
  - domaines légitimes : liste publique Tranco (1 million de sites les plus visités)
  - domaines malveillants : générés selon les techniques réelles (DGA aléatoires, syllabiques,
    hexadécimaux, par mots ; phishing marque + mot-clé ; tunneling encodé en base32 / hex)
Modèle : ensemble de 2 classifieurs (moyenne des probabilités)
  - régression logistique (SGD) sur les n-grammes de caractères
  - Random Forest sur 19 caractéristiques (longueur, entropie, voyelles, chiffres, marques...)
Les domaines de la liste Tranco (top 100 000) servent aussi de liste blanche.
"""
import io
import math
import os
import random
import string
import urllib.request
import zipfile
from collections import Counter

import joblib
import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.feature_extraction.text import HashingVectorizer
from sklearn.linear_model import SGDClassifier
from sklearn.metrics import classification_report
from sklearn.model_selection import train_test_split

MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "domain_model.joblib")
TRANCO_URL = "https://tranco-list.eu/top-1m.csv.zip"

SUSPICIOUS_TLDS = {"xyz", "top", "tk", "ml", "ga", "cf", "gq", "zip", "click", "work", "loan", "rest", "cam", "pw", "su"}
MULTI_SUFFIXES = {"co.uk", "org.uk", "ac.uk", "gov.uk", "com.br", "com.au", "co.jp", "ne.jp", "or.jp", "co.in",
                  "com.cn", "co.za", "com.tr", "com.mx", "co.kr", "com.ar", "gouv.fr", "com.sg", "co.nz", "com.hk"}
VOWELS = set("aeiouy")

BRANDS = ["paypal", "apple", "icloud", "microsoft", "office365", "outlook", "google", "gmail", "amazon", "netflix",
          "facebook", "instagram", "whatsapp", "chase", "wellsfargo", "bankofamerica", "ameli", "impots", "laposte",
          "creditagricole", "bnpparibas", "societegenerale", "orange", "sfr", "bouygues", "dhl", "ups", "fedex",
          "coinbase", "binance", "metamask", "steam", "linkedin", "adobe", "dropbox", "docusign", "caf", "antai"]
KEYWORDS = ["login", "signin", "secure", "verify", "verification", "account", "update", "support", "billing",
            "confirm", "security", "auth", "wallet", "recovery", "unlock", "service", "client", "espace",
            "connexion", "colis", "remboursement", "paiement", "facture", "suivi"]
WORDS = ["about", "after", "again", "air", "animal", "answer", "apple", "area", "base", "bear", "beauty", "bed",
         "bird", "black", "blue", "board", "boat", "body", "book", "box", "bread", "bring", "brown", "build", "card",
         "care", "carry", "cause", "cell", "center", "chair", "change", "city", "class", "clean", "clear", "close",
         "cloud", "cold", "color", "come", "copy", "corn", "cost", "country", "cover", "cross", "dark", "deal",
         "deep", "door", "draw", "dream", "drive", "drop", "early", "earth", "east", "energy", "even", "event",
         "face", "fact", "fair", "fall", "farm", "fast", "field", "fire", "fish", "flow", "fly", "food", "force",
         "forest", "form", "free", "fresh", "friend", "game", "garden", "glass", "gold", "good", "green", "ground",
         "group", "grow", "hand", "happy", "heart", "heat", "help", "high", "hill", "home", "horse", "house",
         "idea", "iron", "island", "jump", "keep", "king", "land", "large", "laugh", "lead", "learn", "light",
         "line", "list", "live", "long", "love", "machine", "main", "mark", "market", "master", "metal", "middle",
         "mind", "money", "moon", "morning", "mother", "mountain", "music", "nation", "nature", "night", "north",
         "ocean", "office", "open", "order", "paper", "party", "past", "peace", "people", "plan", "plant", "point",
         "power", "press", "quick", "rain", "river", "road", "rock", "room", "round", "safe", "salt", "school",
         "science", "season", "second", "sense", "ship", "short", "silver", "simple", "sky", "small", "snow",
         "south", "space", "speed", "spring", "square", "star", "stone", "storm", "story", "street", "strong",
         "summer", "sun", "system", "table", "thing", "time", "tower", "trade", "train", "travel", "tree", "true",
         "united", "valley", "voice", "water", "wave", "west", "wheel", "white", "wild", "wind", "winter", "wood",
         "word", "world", "young", "zone"]
SUBDOMAINS = ["www", "api", "cdn", "m", "mail", "static", "img", "images", "graph", "edge", "app", "login",
              "accounts", "auth", "assets", "media", "video", "s", "i", "ws", "push", "analytics", "metrics",
              "telemetry", "update", "dl", "download", "content", "web", "news", "shop", "store", "help", "support",
              "docs", "blog", "status", "id", "connect", "sync", "gateway", "events", "ads", "tracking", "beacon"]
CITIES = ["fra", "cdg", "par", "ams", "lhr", "mad", "mrs", "iad", "sjc", "nrt", "sin", "lax", "mia", "dfw"]

_vectorizer = HashingVectorizer(analyzer="char", ngram_range=(2, 4), n_features=2**18, alternate_sign=False)


# ---------------------------------------------------------------------------
# Caractéristiques
# ---------------------------------------------------------------------------

def entropy(text):
    if not text:
        return 0.0
    n = len(text)
    return -sum(c / n * math.log2(c / n) for c in Counter(text).values())


def registered_domain(domain):
    labels = domain.lower().strip(".").split(".")
    if len(labels) >= 3 and ".".join(labels[-2:]) in MULTI_SUFFIXES:
        return ".".join(labels[-3:])
    return ".".join(labels[-2:])


def handcrafted(domain):
    d = domain.lower().strip(".")
    labels = d.split(".")
    reg = registered_domain(d)
    sld = reg.split(".")[0]
    sub = d[: -len(reg)].rstrip(".") if d != reg else ""
    longest = max(labels, key=len)
    chars = d.replace(".", "")
    letters = [c for c in sld if c.isalpha()]

    run = best_run = 0
    for c in sld:
        run = run + 1 if c.isalpha() and c not in VOWELS else 0
        best_run = max(best_run, run)

    return [
        len(d), len(sld), len(sub), len(labels), len(longest),
        entropy(sld), entropy(chars),
        sum(c.isdigit() for c in sld) / max(len(sld), 1),
        sum(c.isdigit() for c in chars) / max(len(chars), 1),
        sum(c in VOWELS for c in letters) / max(len(letters), 1),
        best_run,
        d.count("-"),
        sum(len(label) >= 8 and all(ch in "0123456789abcdef" for ch in label) for label in labels),
        float(labels[-1] in SUSPICIOUS_TLDS),
        len(labels[-1]),
        sum(k in d for k in KEYWORDS),
        sum(b in d for b in BRANDS),
        float(any(b in sld for b in BRANDS) and sld not in BRANDS),  # marque mélangée à d'autres mots
        len(set(sld)) / max(len(sld), 1),
    ]


# ---------------------------------------------------------------------------
# Génération des données d'entraînement
# ---------------------------------------------------------------------------

def _rand(chars, a, b):
    return "".join(random.choice(chars) for _ in range(random.randint(a, b)))


def gen_benign(registered):
    r = random.random()
    if r < 0.4:
        return registered
    if r < 0.85:
        return f"{random.choice(SUBDOMAINS)}.{registered}"
    if r < 0.95:
        prefix = random.choice(["scontent", "edge", "static", "media", "video", "cdn"])
        return f"{prefix}-{random.choice(CITIES)}{random.randint(1, 9)}-{random.randint(1, 3)}.{random.choice(SUBDOMAINS)}.{registered}"
    return f"{random.choice(SUBDOMAINS)}{random.randint(1, 20)}.{random.choice(SUBDOMAINS)}.{registered}"


def gen_dga():
    tlds = ["com", "net", "org", "info", "biz", "ru", "xyz", "top", "cc", "pw", "tk", "in", "club", "online", "site", "cn", "su"]
    kind = random.randint(0, 4)
    if kind == 0:
        name = _rand(string.ascii_lowercase + string.digits, 8, 25)
    elif kind == 1:
        name = _rand(string.ascii_lowercase, 10, 22)
    elif kind == 2:
        name = ("%032x" % random.getrandbits(128))[: random.randint(12, 32)]
    elif kind == 3:
        name = "".join(random.choice("bcdfghjklmnprstvwxz") + random.choice("aeiou") for _ in range(random.randint(3, 7)))
    else:
        name = "".join(random.sample(WORDS, random.randint(2, 3)))
    return f"{name}.{random.choice(tlds)}"


def gen_tunneling():
    alphabet = random.choice([string.ascii_lowercase + "234567", "0123456789abcdef", string.ascii_lowercase + string.digits])
    labels = [_rand(alphabet, 20, 63) for _ in range(random.randint(1, 3))]
    if random.random() < 0.5:
        labels.append(str(random.randint(0, 99999)))
    base = random.choice(WORDS) + random.choice(["", "-ns", "dns", "cdn"]) + "." + random.choice(["com", "net", "org", "io", "xyz", "info"])
    return ".".join(labels) + "." + random.choice(["", "t.", "d."]) + base


def gen_phishing():
    tlds = ["com", "net", "org", "info", "xyz", "top", "online", "site", "support", "app", "live", "fr", "co"]
    b, k1, k2 = random.choice(BRANDS), random.choice(KEYWORDS), random.choice(KEYWORDS)
    tld = random.choice(tlds)
    pattern = random.randint(0, 5)
    if pattern == 0:
        return f"{b}-{k1}.{tld}"
    if pattern == 1:
        return f"{k1}-{b}-{k2}.{tld}"
    if pattern == 2:
        return f"{b}.{k1}-{k2}.{tld}"
    if pattern == 3:
        return f"{b}{k1}{random.randint(1, 999)}.{tld}"
    if pattern == 4:
        return f"www.{b}-{k1}.{_rand(string.ascii_lowercase, 4, 8)}.{tld}"
    return f"{k1}.{b}.com.{_rand(string.ascii_lowercase, 5, 10)}.{tld}"


def download_tranco(limit):
    print(f"Téléchargement de la liste Tranco ({TRANCO_URL})...", flush=True)
    with urllib.request.urlopen(TRANCO_URL, timeout=180) as resp:
        data = resp.read()
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        lines = z.read(z.namelist()[0]).decode().splitlines()
    return [line.split(",")[1].strip().lower() for line in lines[:limit] if "," in line]


# ---------------------------------------------------------------------------
# Entraînement
# ---------------------------------------------------------------------------

def train(top_domains=None, n_benign=80000, n_dga=30000, n_phishing=20000, n_tunneling=15000, whitelist_size=100000):
    random.seed(42)
    top = top_domains or download_tranco(max(whitelist_size, n_benign))
    print(f"{len(top)} domaines légitimes de référence", flush=True)

    domains = [gen_benign(random.choice(top)) for _ in range(n_benign)]
    labels = ["benign"] * n_benign
    for generator, name, n in [(gen_dga, "dga", n_dga), (gen_phishing, "phishing", n_phishing), (gen_tunneling, "tunneling", n_tunneling)]:
        domains += [generator() for _ in range(n)]
        labels += [name] * n

    x_train, x_test, y_train, y_test = train_test_split(domains, labels, test_size=0.2, random_state=42, stratify=labels)

    print("Entraînement de la régression logistique (n-grammes)...", flush=True)
    sgd = SGDClassifier(loss="log_loss", alpha=1e-6, max_iter=30, tol=1e-4, random_state=42, n_jobs=-1)
    sgd.fit(_vectorizer.transform(x_train), y_train)

    print("Entraînement du Random Forest (caractéristiques)...", flush=True)
    rf = RandomForestClassifier(n_estimators=150, min_samples_leaf=2, n_jobs=-1, random_state=42)
    rf.fit(np.array([handcrafted(d) for d in x_train]), y_train)

    proba = (sgd.predict_proba(_vectorizer.transform(x_test)) + rf.predict_proba(np.array([handcrafted(d) for d in x_test]))) / 2
    predicted = sgd.classes_[proba.argmax(axis=1)]
    print("\nRésultats sur le jeu de test (20 %) :")
    print(classification_report(y_test, predicted, digits=3))

    os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)
    joblib.dump({
        "sgd": sgd,
        "rf": rf,
        "classes": list(sgd.classes_),
        "whitelist": set(top[:whitelist_size]),
    }, MODEL_PATH, compress=3)
    print(f"Modèle enregistré : {MODEL_PATH}")


# ---------------------------------------------------------------------------
# Prédiction
# ---------------------------------------------------------------------------

class DomainModel:
    def __init__(self, path=MODEL_PATH):
        bundle = joblib.load(path)
        self.sgd = bundle["sgd"]
        self.rf = bundle["rf"]
        self.classes = bundle["classes"]
        self.whitelist = bundle["whitelist"]
        for model in (self.sgd, self.rf):
            if hasattr(model, "n_jobs"):
                model.n_jobs = 1  # une prédiction à la fois : plus rapide sans parallélisme
        self.cache = {}

    def predict(self, domain):
        d = domain.lower().strip(".")
        if d in self.cache:
            return self.cache[d]

        proba = (self.sgd.predict_proba(_vectorizer.transform([d]))[0]
                 + self.rf.predict_proba(np.array([handcrafted(d)]))[0]) / 2
        probs = dict(zip(self.classes, proba))
        malicious = 1 - probs["benign"]

        # Domaine très populaire : risque fortement réduit (sauf tunneling très probable)
        whitelisted = registered_domain(d) in self.whitelist
        if whitelisted and probs["tunneling"] < 0.8:
            malicious *= 0.2

        threat = max((c for c in self.classes if c != "benign"), key=probs.get)
        result = {
            "class": threat if malicious >= 0.5 else "benign",
            "malicious_probability": round(float(malicious), 3),
            "whitelisted": whitelisted,
            "probabilities": {c: round(float(p), 3) for c, p in probs.items()},
        }
        if len(self.cache) > 50000:
            self.cache.clear()
        self.cache[d] = result
        return result


def load_model():
    """Retourne le modèle, ou None s'il n'a pas encore été entraîné."""
    try:
        return DomainModel()
    except FileNotFoundError:
        return None


if __name__ == "__main__":
    train()