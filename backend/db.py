"""Connexion MongoDB et création du schéma (index + compte administrateur)."""
import os

from pymongo import ASCENDING, DESCENDING, MongoClient
from werkzeug.security import generate_password_hash

# Collections alimentées par l'application mobile (mêmes noms que les tables SQLite)
SYNC_COLLECTIONS = [
    "system_metrics",
    "network_metrics",
    "flow_metrics",
    "gps_metrics",
    "rrc_messages",
    "pcap_captures",
    "ml_predictions",
]

_client = None


def get_db():
    global _client
    if _client is None:
        _client = MongoClient(os.environ["MONGO_URI"])
    return _client[os.environ.get("MONGO_DB", "netdata")]


def init_db():
    db = get_db()

    for name in SYNC_COLLECTIONS:
        # (device_id, local_id) unique : un même enregistrement renvoyé n'est jamais dupliqué
        db[name].create_index([("device_id", ASCENDING), ("local_id", ASCENDING)], unique=True)
        db[name].create_index([("device_id", ASCENDING), ("timestamp", DESCENDING)])

    db.users.create_index("username", unique=True)
    # Codes d'association supprimés automatiquement par MongoDB après expiration
    db.pairing_codes.create_index("expires_at", expireAfterSeconds=0)

    username = os.environ.get("ADMIN_USERNAME")
    password = os.environ.get("ADMIN_PASSWORD")
    if username and password and db.users.count_documents({"username": username}) == 0:
        db.users.insert_one({
            "username": username,
            "password_hash": generate_password_hash(password),
            "role": "admin",
        })


if __name__ == "__main__":
    init_db()
    print("Schéma MongoDB initialisé.")