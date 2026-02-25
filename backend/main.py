"""
Smart Helmet Monitoring Server — Complete Backend
Handles:
  - Emergency SMS to all contacts via Twilio
  - Firebase RTDB listener for crash detection
  - Location sharing via SMS
  - Health checks
"""

import os
import json
import threading
from datetime import datetime
from typing import List, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from dotenv import load_dotenv
from twilio.rest import Client
import logging

# ── Load env ──
load_dotenv()

TWILIO_SID = os.getenv("TWILIO_SID")
TWILIO_AUTH = os.getenv("TWILIO_AUTH")
TWILIO_PHONE = os.getenv("TWILIO_PHONE")

# ── Logging ──
LOG_DIR = os.path.join(os.path.dirname(__file__), "..", "logs")
os.makedirs(LOG_DIR, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
    handlers=[
        logging.FileHandler(os.path.join(LOG_DIR, "backend.log")),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger("helmet_server")

# ── Twilio Client ──
twilio_client = None
try:
    if TWILIO_SID and TWILIO_AUTH:
        twilio_client = Client(TWILIO_SID, TWILIO_AUTH)
        logger.info("✅ Twilio client initialized successfully")
    else:
        logger.warning("⚠ Twilio credentials missing — SMS will not work")
except Exception as e:
    logger.error(f"❌ Twilio init failed: {e}")

# ── FastAPI App ──
app = FastAPI(
    title="Smart Helmet Monitoring Server",
    description="Backend for HelmetGuard — handles emergency SMS, crash detection, and location sharing",
    version="2.0"
)

# CORS — allow the frontend to call this
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Local event log ──
EVENT_LOG_FILE = os.path.join(os.path.dirname(__file__), "database", "event_logs.json")
os.makedirs(os.path.dirname(EVENT_LOG_FILE), exist_ok=True)


def save_event_log(event: dict):
    """Save event to local JSON log file."""
    try:
        events = []
        if os.path.exists(EVENT_LOG_FILE):
            with open(EVENT_LOG_FILE, "r") as f:
                events = json.load(f)
        events.append(event)
        with open(EVENT_LOG_FILE, "w") as f:
            json.dump(events, f, indent=2)
        logger.info("Event saved to local log")
    except Exception as e:
        logger.error(f"Failed to save event: {e}")


# ═══════ Pydantic Models ═══════

class Contact(BaseModel):
    name: str
    phone: str
    relation: str


class EmergencySMSRequest(BaseModel):
    riderName: str
    riderPhone: str
    bloodGroup: Optional[str] = None
    vehicle: Optional[str] = None
    crashGforce: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    contacts: List[Contact]


class LocationShareRequest(BaseModel):
    riderName: str
    latitude: float
    longitude: float
    contacts: List[Contact]


# ═══════ API Endpoints ═══════

@app.get("/")
def health_check():
    """Health check endpoint."""
    return {
        "status": "running",
        "service": "HelmetGuard Monitoring Server",
        "version": "2.0",
        "twilio": "connected" if twilio_client else "not configured",
        "timestamp": datetime.now().isoformat()
    }


@app.post("/api/send-emergency-sms")
async def send_emergency_sms(req: EmergencySMSRequest):
    """
    Send emergency SMS to ALL emergency contacts.
    Includes rider info, crash G-force, GPS location, and Google Maps link.
    """
    if not twilio_client:
        raise HTTPException(status_code=503, detail="Twilio not configured. Add credentials to .env")

    if not req.contacts:
        raise HTTPException(status_code=400, detail="No emergency contacts provided")

    # Build Google Maps link
    map_link = "Location unavailable"
    if req.latitude and req.longitude:
        map_link = f"https://maps.google.com/maps?q={req.latitude},{req.longitude}"

    # Build emergency message — PLAIN ASCII ONLY!
    # Emojis force UCS-2 encoding (70 chars/segment vs 160).
    # Indian carriers reject 8-segment SMS. Keep under 3 segments (480 chars).
    time_str = datetime.now().strftime('%d %b %Y %I:%M %p')
    message_body = (
        f"EMERGENCY ALERT - HelmetGuard\n"
        f"{req.riderName} may have had an accident!\n"
        f"No response in 15 sec after impact.\n"
        f"Location: {map_link}\n"
        f"Impact: {req.crashGforce or '?'}G\n"
        f"Blood: {req.bloodGroup or '?'}\n"
        f"Phone: +91{req.riderPhone}\n"
        f"Time: {time_str}\n"
        f"Call 108 for ambulance."
    )

    results = []
    for contact in req.contacts:
        phone_number = contact.phone
        # Ensure proper format
        if not phone_number.startswith("+"):
            phone_number = f"+91{phone_number}"

        try:
            msg = twilio_client.messages.create(
                body=message_body,
                from_=TWILIO_PHONE,
                to=phone_number
            )
            results.append({
                "contact": contact.name,
                "phone": phone_number,
                "status": "sent",
                "sid": msg.sid
            })
            logger.info(f"✅ Emergency SMS sent to {contact.name} ({phone_number}) — SID: {msg.sid}")
        except Exception as e:
            results.append({
                "contact": contact.name,
                "phone": phone_number,
                "status": "failed",
                "error": str(e)
            })
            logger.error(f"❌ SMS to {contact.name} ({phone_number}) failed: {e}")

    # Log the emergency event
    event = {
        "type": "EMERGENCY",
        "timestamp": datetime.now().isoformat(),
        "rider": req.riderName,
        "riderPhone": req.riderPhone,
        "gforce": req.crashGforce,
        "location": {"lat": req.latitude, "lng": req.longitude},
        "mapLink": map_link,
        "smsResults": results
    }
    save_event_log(event)

    sent_count = sum(1 for r in results if r["status"] == "sent")
    return {
        "success": True,
        "message": f"Emergency SMS sent to {sent_count}/{len(req.contacts)} contacts",
        "results": results
    }


@app.post("/api/share-location")
async def share_location(req: LocationShareRequest):
    """Share rider's current location with emergency contacts via SMS."""
    if not twilio_client:
        raise HTTPException(status_code=503, detail="Twilio not configured")

    if not req.contacts:
        raise HTTPException(status_code=400, detail="No contacts provided")

    map_link = f"https://maps.google.com/maps?q={req.latitude},{req.longitude}"
    message_body = (
        f"{req.riderName}'s Location:\n"
        f"{map_link}\n"
        f"- HelmetGuard Safety"
    )

    results = []
    for contact in req.contacts:
        phone_number = contact.phone
        if not phone_number.startswith("+"):
            phone_number = f"+91{phone_number}"
        try:
            msg = twilio_client.messages.create(
                body=message_body,
                from_=TWILIO_PHONE,
                to=phone_number
            )
            results.append({"contact": contact.name, "status": "sent", "sid": msg.sid})
            logger.info(f"📍 Location SMS sent to {contact.name}")
        except Exception as e:
            results.append({"contact": contact.name, "status": "failed", "error": str(e)})
            logger.error(f"Location SMS to {contact.name} failed: {e}")

    return {"success": True, "results": results}


@app.get("/api/events")
async def get_events():
    """Get all logged events."""
    try:
        if os.path.exists(EVENT_LOG_FILE):
            with open(EVENT_LOG_FILE, "r") as f:
                events = json.load(f)
            return {"events": events}
        return {"events": []}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ═══════ Startup ═══════

@app.on_event("startup")
async def startup():
    logger.info("=" * 60)
    logger.info("🪖 HelmetGuard Monitoring Server v2.0 started")
    logger.info(f"   Twilio: {'✅ Connected' if twilio_client else '❌ Not configured'}")
    logger.info("=" * 60)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)