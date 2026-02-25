from twilio.rest import Client
from config import settings
from utils.logger import logger

client = Client(settings.TWILIO_SID, settings.TWILIO_AUTH)

def send_sms():
    try:
        message = client.messages.create(
            body="Emergency Alert! Accident detected. Please check immediately.",
            from_=settings.TWILIO_PHONE,
            to=settings.USER_PHONE
        )

        logger.info(f"SMS sent successfully: {message.sid}")
        return True

    except Exception as e:
        logger.error(f"SMS failed: {e}")
        return False