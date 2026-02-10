// ============================================================
// Firebase MFA Login Flow
// Step 1: MySQL credential check  →  Step 2: Firebase OTP  →  Final JWT
// ============================================================

// --- Firebase Init (compat SDK loaded via CDN in login.html) ---
const firebaseConfig = {
  apiKey: "AIzaSyAJ8sL9SAljeKAlYqc_Xla6JGLj8g7k8UE",
  authDomain: "safespeak-9fcc2.firebaseapp.com",
  projectId: "safespeak-9fcc2",
  storageBucket: "safespeak-9fcc2.firebasestorage.app",
  messagingSenderId: "849732452517",
  appId: "1:849732452517:web:3e43f6a58908ff2a21cd4c",
  measurementId: "G-TEZYC60L46"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();

// Track intermediate state between Step 1 and Step 2
let pendingAuth = {
  tempToken: null,
  role: null,
  email: null,
  voterId: null
};

// Helper: show message
function showMsg(text, isError) {
  const el = document.getElementById('loginMsg');
  el.style.color = isError ? '#ff5252' : '#4fc3f7';
  el.textContent = text;
}

// =========================
// STEP 1 — MySQL Login
// =========================
const loginForm = document.getElementById('loginForm');

loginForm.addEventListener('submit', (event) => {
  event.preventDefault();
  showMsg('Authenticating...', false);

  const voter_id = document.getElementById('voter-id').value.trim();
  const password = document.getElementById('password').value;

  if (!voter_id || !password) {
    showMsg('Please enter both Voter ID and Password.', true);
    return;
  }

  const headers = {
    'method': 'GET',
    'Authorization': `Bearer ${voter_id}`,
  };

  fetch(`http://127.0.0.1:8000/login?voter_id=${voter_id}&password=${password}`, { headers })
    .then(response => {
      if (response.ok) return response.json();
      throw new Error('Invalid credentials');
    })
    .then(data => {
      // Store intermediate auth state
      pendingAuth.tempToken = data.token;
      pendingAuth.role = data.role;
      pendingAuth.voterId = voter_id;
      pendingAuth.email = data.email || voter_id + '@voter.local';

      // Show Step 2 — OTP section
      document.getElementById('loginForm').style.display = 'none';
      document.getElementById('otpSection').style.display = 'block';

      // Send Firebase email OTP
      sendFirebaseOTP(pendingAuth.email);
    })
    .catch(error => {
      showMsg('Login failed: ' + error.message, true);
    });
});

// =========================
// Firebase Email OTP Send
// =========================
function sendFirebaseOTP(email) {
  showMsg('Sending OTP to ' + email + '...', false);

  const actionCodeSettings = {
    url: window.location.href,
    handleCodeInApp: true,
  };

  auth.sendSignInLinkToEmail(email, actionCodeSettings)
    .then(() => {
      window.localStorage.setItem('emailForSignIn', email);
      showMsg('OTP sent! Check your email and enter the code.', false);
    })
    .catch((error) => {
      console.error('Firebase OTP error:', error);
      showMsg('Firebase email not configured. Using mock OTP: 123456', false);
      pendingAuth.useMock = true;
    });
}

// =========================
// STEP 2 — Verify OTP
// =========================
document.getElementById('verifyOtpBtn').addEventListener('click', () => {
  const otpCode = document.getElementById('otpInput').value.trim();

  if (!otpCode || otpCode.length < 6) {
    showMsg('Please enter a valid 6-digit OTP.', true);
    return;
  }

  showMsg('Verifying OTP...', false);

  if (pendingAuth.useMock) {
    if (otpCode === '123456') {
      handleMockVerification();
    } else {
      showMsg('Invalid OTP code.', true);
    }
  } else {
    handleFirebaseVerification(otpCode);
  }
});

// --- Mock verification (development fallback) ---
function handleMockVerification() {
  fetch('http://127.0.0.1:8000/verify-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      idToken: 'mock-firebase-token',
      tempToken: pendingAuth.tempToken,
      voterId: pendingAuth.voterId,
      mock: true
    })
  })
    .then(res => {
      if (res.ok) return res.json();
      throw new Error('OTP verification failed');
    })
    .then(data => {
      completeLogin(data.sessionToken, pendingAuth.role);
    })
    .catch(err => {
      showMsg('Verification failed: ' + err.message, true);
    });
}

// --- Real Firebase verification ---
function handleFirebaseVerification(otpCode) {
  const email = window.localStorage.getItem('emailForSignIn') || pendingAuth.email;

  auth.signInWithEmailAndPassword(email, otpCode)
    .then((userCredential) => {
      return userCredential.user.getIdToken();
    })
    .then((idToken) => {
      return fetch('http://127.0.0.1:8000/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idToken: idToken,
          tempToken: pendingAuth.tempToken,
          voterId: pendingAuth.voterId,
          mock: false
        })
      });
    })
    .then(res => {
      if (res.ok) return res.json();
      throw new Error('Backend verification failed');
    })
    .then(data => {
      completeLogin(data.sessionToken, pendingAuth.role);
    })
    .catch(err => {
      showMsg('Verification failed: ' + err.message, true);
    });
}

// =========================
// Final Redirect
// =========================
function completeLogin(sessionToken, role) {
  showMsg('✓ Verified! Redirecting...', false);

  if (role === 'admin') {
    localStorage.setItem('jwtTokenAdmin', sessionToken);
    window.location.replace(
      `http://127.0.0.1:8080/admin.html?Authorization=Bearer ${sessionToken}`
    );
  } else {
    localStorage.setItem('jwtTokenVoter', sessionToken);
    window.location.replace(
      `http://127.0.0.1:8080/index.html?Authorization=Bearer ${sessionToken}`
    );
  }
}
