"""
Direct Twilio SMS Test — Run this to verify SMS delivery
Usage: python test_sms.py +91XXXXXXXXXX
"""
import sys
import os
from dotenv import load_dotenv
from twilio.rest import Client

load_dotenv()

SID = os.getenv("TWILIO_SID")
AUTH = os.getenv("TWILIO_AUTH")
FROM = os.getenv("TWILIO_PHONE")

print("=" * 50)
print("TWILIO SMS DIRECT TEST")
print("=" * 50)
print(f"Account SID: {SID}")
print(f"Auth Token:  {AUTH[:6]}...{AUTH[-4:]}")
print(f"From Number: {FROM}")
print()

if len(sys.argv) < 2:
    print("Usage: python test_sms.py +919876543210")
    print("Enter the phone number to send test SMS to:")
    to_number = input("> ").strip()
else:
    to_number = sys.argv[1]

if not to_number.startswith("+"):
    to_number = "+91" + to_number

print(f"Sending to:  {to_number}")
print()

try:
    client = Client(SID, AUTH)
    
    # First check verified numbers
    print("Checking verified caller IDs...")
    try:
        verified = client.validation_requests.list()
        outgoing = client.outgoing_caller_ids.list()
        print(f"Verified numbers ({len(outgoing)}):")
        for v in outgoing:
            print(f"  ✓ {v.phone_number} ({v.friendly_name})")
        print()
    except Exception as e:
        print(f"Could not list verified numbers: {e}")
        print()

    # Send test SMS
    print(f"Sending SMS to {to_number}...")
    msg = client.messages.create(
        body="✅ HelmetGuard Test SMS — Your Twilio setup is working! This is a test message from the Smart Helmet Safety System.",
        from_=FROM,
        to=to_number
    )
    print(f"✅ SUCCESS! Message SID: {msg.sid}")
    print(f"   Status: {msg.status}")
    print(f"   Price: {msg.price}")
    print()
    print("If you don't receive the SMS within 1-2 minutes,")
    print("the number may not be verified in your Twilio account.")
    
except Exception as e:
    print(f"❌ FAILED: {e}")
    print()
    if "unverified" in str(e).lower():
        print("SOLUTION: This number is NOT verified in your Twilio trial account.")
        print("Go to: https://console.twilio.com/us1/develop/phone-numbers/manage/verified")
        print("Click 'Add a new Caller ID' and verify this number.")
    elif "authenticate" in str(e).lower():
        print("SOLUTION: Your Twilio SID or Auth Token is wrong.")
        print("Check your .env file.")
    elif "not a valid phone" in str(e).lower():
        print("SOLUTION: The phone number format is wrong. Use +91XXXXXXXXXX format.")
    else:
        print("Check your Twilio dashboard: https://console.twilio.com/")
