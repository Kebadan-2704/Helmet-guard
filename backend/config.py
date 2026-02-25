import os
from dotenv import load_dotenv

load_dotenv()

class Settings:
    PROJECT_NAME = "Smart Helmet Monitoring Server"

    FIREBASE_CRED = os.getenv("FIREBASE_CRED")
    DATABASE_URL = os.getenv("DATABASE_URL")

    TWILIO_SID = os.getenv("TWILIO_SID")
    TWILIO_AUTH = os.getenv("TWILIO_AUTH")
    TWILIO_PHONE = os.getenv("TWILIO_PHONE")

    USER_PHONE = os.getenv("USER_PHONE")

settings = Settings()