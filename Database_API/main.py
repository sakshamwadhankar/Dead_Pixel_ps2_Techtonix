# Import required modules
import dotenv
import os
import mysql.connector
from fastapi import FastAPI, HTTPException, status, Request
from fastapi.middleware.cors import CORSMiddleware
from mysql.connector import errorcode
import jwt
from pymongo import MongoClient
from pydantic import BaseModel
from typing import Optional
import firebase_admin
from firebase_admin import credentials, auth as firebase_auth

# Loading the environment variables
dotenv.load_dotenv()

# Also load root .env if exists
root_env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '.env')
if os.path.exists(root_env_path):
    dotenv.load_dotenv(root_env_path)

# Initialize the app
app = FastAPI()

# Define the allowed origins for CORS
origins = [
    "http://localhost:8080",
    "http://127.0.0.1:8080",
]

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# =====================
# MySQL Connection
# =====================
cnx = None
cursor = None
try:
    cnx = mysql.connector.connect(
        user=os.environ.get('MYSQL_USER', 'root'),
        password=os.environ.get('MYSQL_PASSWORD', ''),
        host=os.environ.get('MYSQL_HOST', 'localhost'),
        database=os.environ.get('MYSQL_DB', 'voter_db'),
    )
    cursor = cnx.cursor()
    print("Connected to MySQL")
except mysql.connector.Error as err:
    if err.errno == errorcode.ER_ACCESS_DENIED_ERROR:
        print("Something is wrong with your user name or password")
    elif err.errno == errorcode.ER_BAD_DB_ERROR:
        print("Database does not exist")
    else:
        print(err)

# =====================
# MongoDB Connection
# =====================
mongo_uri = os.environ.get('MONGODB_URI', 'mongodb://localhost:27017')
mongo_db_name = os.environ.get('MONGODB_DB', 'election_pro')
try:
    mongo_client = MongoClient(mongo_uri)
    mongo_db = mongo_client[mongo_db_name]
    candidates_collection = mongo_db['candidates']
    print(f"Connected to MongoDB: {mongo_db_name}")
except Exception as e:
    print(f"MongoDB connection failed: {e}")
    mongo_client = None
    candidates_collection = None

# =====================
# Firebase Admin Init
# =====================
firebase_initialized = False
try:
    service_account_path = os.environ.get('FIREBASE_SERVICE_ACCOUNT_PATH', '')
    if service_account_path and os.path.exists(service_account_path):
        cred = credentials.Certificate(service_account_path)
        firebase_admin.initialize_app(cred)
    else:
        firebase_admin.initialize_app(options={
            'projectId': os.environ.get('FIREBASE_PROJECT_ID', 'safespeak-9fcc2')
        })
    firebase_initialized = True
    print("Firebase Admin SDK initialized")
except Exception as e:
    print(f"Firebase Admin init warning: {e}")
    firebase_initialized = False

# =====================
# Auth Middleware
# =====================
async def authenticate(request: Request):
    try:
        api_key = request.headers.get('authorization').replace("Bearer ", "")
        cursor.execute("SELECT * FROM voters WHERE voter_id = %s", (api_key,))
        if api_key not in [row[0] for row in cursor.fetchall()]:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Forbidden"
            )
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Forbidden"
        )

# =====================
# GET /login — Step 1: MySQL credential check
# =====================
@app.get("/login")
async def login(request: Request, voter_id: str, password: str):
    await authenticate(request)
    role = await get_role(voter_id, password)

    # Issue a TEMPORARY token (not the final session token)
    temp_token = jwt.encode(
        {'voter_id': voter_id, 'role': role, 'step': 'pending_otp'},
        os.environ['SECRET_KEY'],
        algorithm='HS256'
    )

    return {'token': temp_token, 'role': role}


async def get_role(voter_id, password):
    try:
        cursor.execute(
            "SELECT role FROM voters WHERE voter_id = %s AND password = %s",
            (voter_id, password,)
        )
        role = cursor.fetchone()
        if role:
            return role[0]
        else:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid voter id or password"
            )
    except mysql.connector.Error as err:
        print(err)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Database error"
        )

# =====================
# POST /verify-otp — Step 2: Firebase OTP verification
# =====================
class OTPVerifyRequest(BaseModel):
    idToken: str
    tempToken: str
    voterId: str
    mock: Optional[bool] = False

@app.post("/verify-otp")
async def verify_otp(body: OTPVerifyRequest):
    # 1. Decode the temp token to confirm Step 1 passed
    try:
        decoded_temp = jwt.decode(
            body.tempToken,
            os.environ['SECRET_KEY'],
            algorithms=['HS256']
        )
        if decoded_temp.get('step') != 'pending_otp':
            raise ValueError("Invalid temp token")
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired temporary token"
        )

    voter_id = decoded_temp['voter_id']
    role = decoded_temp['role']
    firebase_uid = None

    # 2. Verify Firebase ID token (or accept mock in dev)
    if body.mock:
        firebase_uid = f"mock-uid-{voter_id}"
        print(f"[DEV] Mock OTP verified for {voter_id}")
    else:
        if not firebase_initialized:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Firebase Admin SDK not initialized"
            )
        try:
            decoded_firebase = firebase_auth.verify_id_token(body.idToken)
            firebase_uid = decoded_firebase['uid']
            print(f"Firebase verified: uid={firebase_uid}")
        except Exception as e:
            print(f"Firebase token verification failed: {e}")
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Firebase OTP verification failed"
            )

    # 3. Update MySQL: mark voter as verified
    try:
        cursor.execute(
            "UPDATE voters SET is_verified = TRUE, firebase_uid = %s WHERE voter_id = %s",
            (firebase_uid, voter_id)
        )
        cnx.commit()
    except mysql.connector.Error as err:
        print(f"MySQL update error: {err}")

    # 4. Issue FINAL session JWT (includes is_verified flag)
    session_token = jwt.encode(
        {
            'voter_id': voter_id,
            'role': role,
            'is_verified': True,
            'firebase_uid': firebase_uid
        },
        os.environ['SECRET_KEY'],
        algorithm='HS256'
    )

    return {'sessionToken': session_token, 'role': role, 'verified': True}

# =====================
# GET /candidates — MongoDB speed layer
# =====================
@app.get("/candidates")
async def get_candidates():
    """Fetch candidate metadata from MongoDB for fast display."""
    if candidates_collection is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="MongoDB is not connected"
        )
    try:
        candidates = list(candidates_collection.find({}, {"_id": 0}))
        return {"candidates": candidates}
    except Exception as e:
        print(f"Error fetching candidates: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to fetch candidates from database"
        )
