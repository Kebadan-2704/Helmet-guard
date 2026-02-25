import firebase_admin
from firebase_admin import credentials, db
from config import settings
from utils.logger import logger
from services.alert_service import handle_emergency_event

cred = credentials.Certificate(settings.FIREBASE_CRED)

firebase_admin.initialize_app(cred, {
    'databaseURL': settings.DATABASE_URL
})

ref = db.reference('helmet')

def listener(event):
    try:
        data = event.data
        logger.info(f"Firebase Update Received: {data}")

        if isinstance(data, dict) and data.get("status") == "EMERGENCY":
            handle_emergency_event(data)

    except Exception as e:
        logger.error(f"Firebase listener error: {e}")

def start_listener():
    logger.info("Starting Firebase Realtime Listener...")
    ref.listen(listener)