from utils.logger import logger
from services.sms_service import send_sms
from database.event_repository import save_event
from datetime import datetime

def handle_emergency_event(data):

    logger.warning("🚨 EMERGENCY EVENT DETECTED")

    event = {
        "timestamp": datetime.now().isoformat(),
        "gforce": data.get("gforce", 0),
        "status": "EMERGENCY",
        "sms_sent": False
    }

    # Save to database
    save_event(event)

    # Send SMS alert
    success = send_sms()

    if success:
        event["sms_sent"] = True
        save_event(event)