/* ═══════════════════════════════════════════════════════════
   HelmetGuard — Rider Mobile Web App Logic (v2.1)
   
   FIXES in v2.1:
   - Emergency SMS fires ONCE per incident (debounced)
   - Location waited for before sending emergency
   - Mobile-optimized (reduced repaints, rAF throttling)
   - Webcam low-res for mobile perf
   - Prevents duplicate emergency triggers
   - Null-safe DOM lookups throughout
   
   Firebase RTDB paths (from ESP8266):
     /helmet/live_gforce  → float
     /helmet/status       → "SAFE" | "CRASH DETECTED" | "EMERGENCY"
     /helmet/time_ms      → int (millis)
     /helmet/crash_gforce → float
     /helmet/crash_time   → int
   ═══════════════════════════════════════════════════════════ */

// ═══════ CONFIG ═══════
const BACKEND_URL = 'https://helmet-guard.onrender.com';
const PRE_BUFFER_SECONDS = 2;
const POST_RECORD_SECONDS = 20;
const CHUNK_INTERVAL_MS = 1000;

const firebaseConfig = {
    apiKey: "AIzaSyDQRv3211KckM35ToiZCnV0Wo1iQtmtsec",
    databaseURL: "https://helmet-4d7c3-default-rtdb.firebaseio.com/",
    storageBucket: "helmet-4d7c3.appspot.com",
    projectId: "helmet-4d7c3"
};

let db, auth, uid;
const $ = id => document.getElementById(id);

// ─── State ───
const state = {
    user: null,
    contacts: [],
    gforceHistory: [],
    gforceLabels: [],
    updateCount: 0,
    incidents: 0,
    lastStatus: null,
    events: [],
    location: { lat: null, lng: null, accuracy: null },
    map: null,
    marker: null,
    locationWatcher: null,
    chart: null,
    webcamStream: null,
    mediaRecorder: null,
    videoChunks: [],
    isRecordingIncident: false,
    incidentChunks: [],
    preIncidentChunks: [],
    recordingStartTime: null,
    recordingTimer: null,
    // Emergency dedup
    emergencyAlertSent: false,
    lastEmergencyTime: 0,
    emergencyCooldown: 60000,
    chartUpdatePending: false,
    // Gallery
    gallery: []
};

// ═══════════════════════════════════════
//  INIT
// ═══════════════════════════════════════
window.addEventListener('DOMContentLoaded', () => {
    firebase.initializeApp(firebaseConfig);
    db = firebase.database();
    auth = firebase.auth();

    setTimeout(() => {
        const saved = localStorage.getItem('helmetguard_user');
        if (saved) {
            state.user = JSON.parse(saved);
            const savedContacts = localStorage.getItem('helmetguard_contacts');
            if (savedContacts) state.contacts = JSON.parse(savedContacts);
            authAndStart();
        } else {
            showScreen('signupScreen');
        }
    }, 2200);

    bindAllEvents();
    requestNotificationPermission();
});

// ═══════════════════════════════════════
//  SCREEN MANAGEMENT
// ═══════════════════════════════════════
function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    $(id)?.classList.add('active');
}

function showPage(name) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    const pageEl = $('page' + name.charAt(0).toUpperCase() + name.slice(1));
    const navEl = document.querySelector(`.nav-item[data-page="${name}"]`);
    if (pageEl) pageEl.classList.add('active');
    if (navEl) navEl.classList.add('active');

    const titles = {
        home: '<i class="fas fa-house"></i> Home',
        location: '<i class="fas fa-location-dot"></i> Your Location',
        family: '<i class="fas fa-users"></i> Your Family',
        profile: '<i class="fas fa-user"></i> My Profile'
    };
    const titleEl = $('pageTitle');
    if (titleEl) titleEl.innerHTML = titles[name] || '';

    if (name === 'location') setTimeout(() => initMap(), 100);
    if (name === 'family') renderFamilyList();
    if (name === 'profile') checkBackendStatus();
}

// ═══════════════════════════════════════
//  AUTH & SIGNUP
// ═══════════════════════════════════════
function authAndStart() {
    auth.signInAnonymously().then(cred => {
        uid = cred.user.uid;
        db.ref(`/users/${uid}/profile`).set(state.user);
        if (state.contacts.length > 0) {
            db.ref(`/users/${uid}/contacts`).set(state.contacts);
        }
        startApp();
    }).catch(e => {
        console.warn('Auth failed:', e.message);
        uid = 'anonymous_' + Date.now();
        startApp();
    });
}

function startApp() {
    showScreen('appScreen');
    updateProfileUI();
    initHomeChart();
    startHelmetListener();
    startLocationTracking();
    initWebcam();
    checkBackendStatus();
}

// ═══════════════════════════════════════
//  EVENT BINDING
// ═══════════════════════════════════════
function bindAllEvents() {
    $('signupForm')?.addEventListener('submit', e => {
        e.preventDefault();
        const name = $('inputName').value.trim();
        const phone = $('inputPhone').value.trim();
        const blood = $('inputBlood').value;
        const vehicle = $('inputVehicle').value.trim();
        if (!name || !phone || phone.length !== 10) {
            showToast('Please fill all required fields', true);
            return;
        }
        if (!blood) {
            showToast('Please select blood group', true);
            return;
        }
        state.user = { name, phone, blood, vehicle };
        localStorage.setItem('helmetguard_user', JSON.stringify(state.user));
        showScreen('familySetupScreen');
    });

    $('familyDoneBtn')?.addEventListener('click', () => {
        const c1Name = $('c1Name').value.trim();
        const c1Phone = $('c1Phone').value.trim();
        if (!c1Name || !c1Phone || c1Phone.length !== 10) {
            showToast('Contact 1 is required with 10-digit number', true);
            return;
        }
        state.contacts = [];
        state.contacts.push({ name: c1Name, phone: c1Phone, relation: $('c1Relation').value });

        const c2Name = $('c2Name').value.trim();
        const c2Phone = $('c2Phone').value.trim();
        if (c2Name && c2Phone && c2Phone.length === 10) {
            state.contacts.push({ name: c2Name, phone: c2Phone, relation: $('c2Relation').value });
        }
        const c3Name = $('c3Name').value.trim();
        const c3Phone = $('c3Phone').value.trim();
        if (c3Name && c3Phone && c3Phone.length === 10) {
            state.contacts.push({ name: c3Name, phone: c3Phone, relation: $('c3Relation').value });
        }

        localStorage.setItem('helmetguard_contacts', JSON.stringify(state.contacts));
        showToast('Contacts saved!');
        authAndStart();
    });

    document.querySelectorAll('.nav-item').forEach(btn => {
        btn.addEventListener('click', () => showPage(btn.dataset.page));
    });

    $('refreshLocBtn')?.addEventListener('click', () => updateLocation());
    $('shareLocBtn')?.addEventListener('click', () => shareLocationWithFamily());
    $('addContactBtn')?.addEventListener('click', () => openContactModal());
    $('closeContactModal')?.addEventListener('click', () => closeContactModal());
    $('saveContactBtn')?.addEventListener('click', () => saveContact());
    $('deleteContactBtn')?.addEventListener('click', () => deleteContact());
    $('editProfileBtn')?.addEventListener('click', () => showToast('Edit profile: Coming soon'));

    $('logoutBtn')?.addEventListener('click', () => {
        localStorage.removeItem('helmetguard_user');
        localStorage.removeItem('helmetguard_contacts');
        state.user = null;
        state.contacts = [];
        stopWebcam();
        showScreen('signupScreen');
        showToast('Logged out');
    });
}

// ═══════════════════════════════════════
//  WEBCAM (Always On - Mobile Optimized)
// ═══════════════════════════════════════
async function initWebcam() {
    const video = $('webcamPreview');
    const overlay = $('webcamOverlay');
    const statusEl = $('webcamStatus');

    if (!video || !navigator.mediaDevices) {
        if (overlay) overlay.innerHTML = '<i class="fas fa-video-slash"></i><span>Camera not supported</span>';
        return;
    }

    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                width: { ideal: 640, max: 1280 },
                height: { ideal: 480, max: 720 },
                facingMode: { ideal: 'environment' }
            },
            audio: false
        });

        state.webcamStream = stream;
        video.srcObject = stream;
        video.onloadedmetadata = () => {
            video.play().catch(() => { });
            if (overlay) overlay.classList.add('hidden');
            if (statusEl) statusEl.innerHTML = '<div class="webcam-dot"></div><span>Active</span>';
        };

        setTimeout(() => startRollingBuffer(), 500);

        const camStatus = $('profCameraStatus');
        if (camStatus) { camStatus.textContent = 'Active'; camStatus.style.color = '#00f5a0'; }
        console.log('📷 Webcam initialized');
    } catch (err) {
        console.error('Webcam error:', err);
        if (overlay) overlay.innerHTML = '<i class="fas fa-video-slash"></i><span>Camera access denied.<br>Please allow camera.</span>';
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger);">Denied</span>';
    }
}

function stopWebcam() {
    if (state.webcamStream) { state.webcamStream.getTracks().forEach(t => t.stop()); state.webcamStream = null; }
    if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') { try { state.mediaRecorder.stop(); } catch (e) { } }
    state.mediaRecorder = null;
}

// ═══════════════════════════════════════
//  ROLLING VIDEO BUFFER
// ═══════════════════════════════════════
function startRollingBuffer() {
    if (!state.webcamStream) return;
    const mimeType = getSupportedMimeType();
    try {
        const recorder = new MediaRecorder(state.webcamStream, { mimeType, videoBitsPerSecond: 800000 });
        state.mediaRecorder = recorder;
        state.videoChunks = [];

        recorder.ondataavailable = (e) => {
            if (!e.data || e.data.size === 0) return;
            if (state.isRecordingIncident) {
                state.incidentChunks.push(e.data);
            } else {
                state.videoChunks.push({ data: e.data, timestamp: Date.now() });
                const cutoff = Date.now() - (PRE_BUFFER_SECONDS * 1000);
                state.videoChunks = state.videoChunks.filter(c => c.timestamp >= cutoff);
                const bufferEl = $('bufferStatus');
                if (bufferEl && state.videoChunks.length > 0) {
                    bufferEl.textContent = `Buffer: ${((Date.now() - state.videoChunks[0].timestamp) / 1000).toFixed(0)}s`;
                }
            }
        };
        recorder.onerror = (e) => console.error('MediaRecorder error:', e);
        recorder.start(CHUNK_INTERVAL_MS);
        console.log(`🔴 Rolling buffer started (${PRE_BUFFER_SECONDS}s, ${mimeType})`);
    } catch (err) { console.error('MediaRecorder init failed:', err); }
}

function getSupportedMimeType() {
    for (const t of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']) {
        if (MediaRecorder.isTypeSupported(t)) return t;
    }
    return 'video/webm';
}

// ═══════════════════════════════════════
//  INCIDENT VIDEO RECORDING
// ═══════════════════════════════════════
function startIncidentRecording() {
    if (state.isRecordingIncident) return;
    if (!state.mediaRecorder || state.mediaRecorder.state === 'inactive') {
        console.warn('MediaRecorder not active — cannot record');
        return;
    }
    console.log('🚨 Starting incident recording...');
    state.isRecordingIncident = true;
    state.preIncidentChunks = state.videoChunks.map(c => c.data);
    state.incidentChunks = [];
    state.recordingStartTime = Date.now();

    const badge = $('recordingBadge');
    if (badge) badge.classList.add('active');

    state.recordingTimer = setInterval(() => {
        const elapsed = Math.floor((Date.now() - state.recordingStartTime) / 1000);
        const timerEl = $('recTimer');
        if (timerEl) timerEl.textContent = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
    }, 1000);

    setTimeout(() => stopIncidentRecording(), POST_RECORD_SECONDS * 1000);
    showToast(`📹 Recording ${POST_RECORD_SECONDS}s incident video...`);
}

function stopIncidentRecording() {
    if (!state.isRecordingIncident) return;
    state.isRecordingIncident = false;
    if (state.recordingTimer) { clearInterval(state.recordingTimer); state.recordingTimer = null; }
    const badge = $('recordingBadge');
    if (badge) badge.classList.remove('active');

    const allChunks = [...state.preIncidentChunks, ...state.incidentChunks];
    if (allChunks.length === 0) return;

    const blob = new Blob(allChunks, { type: getSupportedMimeType() });
    const dateStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `HelmetGuard_Incident_${dateStr}.webm`;

    // Store in gallery
    const url = URL.createObjectURL(blob);
    state.gallery.unshift({
        id: Date.now(),
        filename,
        url,
        blob,
        size: blob.size,
        date: new Date(),
        gforce: $('homeGforce') ? $('homeGforce').textContent : '--'
    });
    // Keep max 10 videos in memory
    if (state.gallery.length > 10) {
        const removed = state.gallery.pop();
        URL.revokeObjectURL(removed.url);
    }
    renderGallery();

    state.preIncidentChunks = [];
    state.incidentChunks = [];
    showToast(`Incident video saved! (${(blob.size / 1024 / 1024).toFixed(1)}MB)`);
}

function downloadVideo(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 200);
}

// ═══════════════════════════════════════
//  GALLERY
// ═══════════════════════════════════════
function renderGallery() {
    const list = $('galleryList');
    const countEl = $('galleryCount');
    const emptyEl = $('galleryEmpty');
    if (!list) return;

    if (countEl) countEl.textContent = `${state.gallery.length} clip${state.gallery.length !== 1 ? 's' : ''}`;

    if (state.gallery.length === 0) {
        if (emptyEl) emptyEl.style.display = 'flex';
        // Remove any gallery items
        list.querySelectorAll('.gallery-item').forEach(el => el.remove());
        return;
    }

    if (emptyEl) emptyEl.style.display = 'none';
    // Remove old items
    list.querySelectorAll('.gallery-item').forEach(el => el.remove());

    state.gallery.forEach((item, idx) => {
        const row = document.createElement('div');
        row.className = 'gallery-item';

        const sizeMB = (item.size / 1024 / 1024).toFixed(1);
        const time = item.date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
        const dateFmt = item.date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });

        row.innerHTML = `
            <div class="gallery-thumb"><i class="fas fa-play-circle"></i></div>
            <div class="gallery-item-info">
                <strong>Incident #${state.gallery.length - idx}</strong>
                <span>${dateFmt} ${time} | ${sizeMB}MB | ${item.gforce}G</span>
            </div>
            <div class="gallery-item-actions">
                <button class="gallery-btn" title="Download" onclick="downloadGalleryItem(${item.id})">
                    <i class="fas fa-download"></i>
                </button>
                <button class="gallery-btn danger" title="Delete" onclick="deleteGalleryItem(${item.id})">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        `;
        list.appendChild(row);
    });
}

function downloadGalleryItem(id) {
    const item = state.gallery.find(g => g.id === id);
    if (!item) return;
    downloadVideo(item.blob, item.filename);
    showToast('Downloading video...');
}

function deleteGalleryItem(id) {
    const idx = state.gallery.findIndex(g => g.id === id);
    if (idx === -1) return;
    URL.revokeObjectURL(state.gallery[idx].url);
    state.gallery.splice(idx, 1);
    renderGallery();
    showToast('Video removed');
}

// ═══════════════════════════════════════
//  FIREBASE HELMET LISTENER
// ═══════════════════════════════════════
function startHelmetListener() {
    db.ref('/helmet').on('value', snapshot => {
        const data = snapshot.val();
        if (!data) return;

        state.updateCount++;
        const now = new Date();

        requestAnimationFrame(() => {
            const updEl = $('homeUpdates'); if (updEl) updEl.textContent = state.updateCount;
            const conEl = $('homeConnection'); if (conEl) { conEl.textContent = 'Live'; conEl.style.color = '#00f5a0'; }
        });

        if (data.live_gforce !== undefined) {
            const g = parseFloat(data.live_gforce);
            if (!isNaN(g)) updateGforceDisplay(g, now);
        }

        if (data.time_ms !== undefined) {
            const ms = parseInt(data.time_ms);
            if (!isNaN(ms)) {
                const s = Math.floor(ms / 1000);
                const upEl = $('homeUptime');
                if (upEl) upEl.textContent = `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
            }
        }

        if (data.status !== undefined) {
            const status = String(data.status);
            updateStatusUI(status);

            // Only on STATUS CHANGE
            if (status !== state.lastStatus) {
                state.events.unshift({ status, time: now, gforce: data.crash_gforce || data.live_gforce || null });
                if (state.events.length > 50) state.events.pop();
                renderEvents();

                if (status === 'CRASH DETECTED') startIncidentRecording();

                if (status === 'EMERGENCY') {
                    state.incidents++;
                    const incEl = $('homeIncidents'); if (incEl) incEl.textContent = state.incidents;

                    // SEND SMS ONLY ONCE (60s cooldown)
                    const elapsed = Date.now() - state.lastEmergencyTime;
                    if (!state.emergencyAlertSent || elapsed > state.emergencyCooldown) {
                        state.emergencyAlertSent = true;
                        state.lastEmergencyTime = Date.now();
                        triggerEmergencyAlert(data);
                    } else {
                        console.log('⏳ SMS already sent recently — skipping');
                    }
                    if (!state.isRecordingIncident) startIncidentRecording();
                }

                // Reset flag when safe again
                if (status === 'SAFE') state.emergencyAlertSent = false;

                state.lastStatus = status;
            }
        }

        updateHelmetIndicator(data.status || 'SAFE');
    }, err => {
        console.error('Firebase error:', err);
        const conEl = $('homeConnection'); if (conEl) { conEl.textContent = 'Error'; conEl.style.color = '#F87171'; }
    });
}

// ═══════════════════════════════════════
//  STATUS UI
// ═══════════════════════════════════════
function updateStatusUI(status) {
    const hero = $('heroStatus'), icon = $('heroIcon'), label = $('heroLabel'), sub = $('heroSub'), alertBox = $('crashAlertBox');
    if (!hero || !icon || !label || !sub || !alertBox) return;

    hero.className = 'status-compact';
    alertBox.style.display = 'none';

    if (status === 'SAFE') {
        icon.className = 'fas fa-shield-check'; label.textContent = 'SAFE';
        sub.textContent = 'Your helmet is monitoring. Stay safe!';
    } else if (status === 'CRASH DETECTED') {
        hero.classList.add('warning');
        icon.className = 'fas fa-exclamation-circle'; label.textContent = 'CRASH';
        sub.textContent = 'Impact detected — waiting for your response';
        alertBox.style.display = 'block'; alertBox.className = 'crash-alert-box warning';
        $('crashAlertTitle').textContent = 'CRASH DETECTED!';
        $('crashAlertMsg').textContent = 'Buzzer is ON — Press the button on your helmet within 15 seconds. Video recording started.';
        $('crashAlertTime').textContent = '15 seconds to respond...';
        playVibrate();
    } else if (status === 'EMERGENCY') {
        hero.classList.add('emergency');
        icon.className = 'fas fa-exclamation-triangle'; label.textContent = 'SOS';
        sub.textContent = 'Emergency alert sent to your family';
        alertBox.style.display = 'block'; alertBox.className = 'crash-alert-box';
        $('crashAlertTitle').textContent = 'EMERGENCY — HELP NEEDED';
        $('crashAlertMsg').textContent = 'No response! SMS with your location sent to all emergency contacts.';
        $('crashAlertTime').textContent = new Date().toLocaleTimeString();
        playVibrate();
    }
}

function updateHelmetIndicator(status) {
    const ind = $('helmetIndicator'); if (!ind) return;
    ind.className = 'helmet-indicator';
    if (status === 'CRASH DETECTED') ind.classList.add('warning');
    else if (status === 'EMERGENCY') ind.classList.add('danger');
    const span = ind.querySelector('span');
    if (span) span.textContent = status === 'SAFE' ? 'Helmet Safe' : status === 'CRASH DETECTED' ? 'Crash!' : 'SOS!';
}

// ═══════════════════════════════════════
//  G-FORCE (throttled)
// ═══════════════════════════════════════
function updateGforceDisplay(g, now) {
    requestAnimationFrame(() => {
        const el = $('homeGforce');
        if (el) { el.textContent = g.toFixed(2); el.style.color = g < 1.5 ? '#4ADE80' : g < 2.0 ? '#FBBF24' : '#F87171'; }
        const bar = $('homeGforceBar');
        if (bar) bar.style.width = Math.min((g / 4) * 100, 100) + '%';
    });

    const timeLabel = now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    state.gforceHistory.push(g); state.gforceLabels.push(timeLabel);
    if (state.gforceHistory.length > 40) { state.gforceHistory.shift(); state.gforceLabels.shift(); }

    if (!state.chartUpdatePending) {
        state.chartUpdatePending = true;
        requestAnimationFrame(() => { updateChart(); state.chartUpdatePending = false; });
    }
}

function initHomeChart() {
    const ctx = $('homeChart'); if (!ctx) return;
    state.chart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                { label: 'G-Force', data: [], borderColor: '#D4A843', backgroundColor: 'rgba(212,168,67,0.06)', borderWidth: 1.5, pointRadius: 0, tension: 0.4, fill: true },
                { label: 'Threshold', data: [], borderColor: 'rgba(248,113,113,0.25)', borderWidth: 1, borderDash: [4, 4], pointRadius: 0, fill: false }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false, animation: false,
            layout: { padding: 0 },
            scales: {
                x: { display: true, grid: { display: false }, ticks: { color: '#453D32', font: { size: 7 }, maxTicksLimit: 5 } },
                y: { display: true, min: 0, max: 4, grid: { color: 'rgba(255,255,255,0.02)' }, ticks: { color: '#453D32', font: { size: 7 } } }
            },
            plugins: { legend: { display: false } }
        },
        plugins: [{
            id: 'darkBg',
            beforeDraw: (chart) => {
                const { ctx: c, width, height } = chart;
                c.save();
                c.fillStyle = '#151515';
                c.fillRect(0, 0, width, height);
                c.restore();
            }
        }]
    });
}

function updateChart() {
    if (!state.chart) return;
    state.chart.data.labels = state.gforceLabels;
    state.chart.data.datasets[0].data = state.gforceHistory;
    state.chart.data.datasets[1].data = state.gforceLabels.map(() => 2.0);
    state.chart.update('none');
}

// ═══════════════════════════════════════
//  EVENTS LIST
// ═══════════════════════════════════════
function renderEvents() {
    const el = $('eventsList'); if (!el || state.events.length === 0) return;
    el.innerHTML = state.events.slice(0, 8).map(ev => {
        const cls = ev.status === 'SAFE' ? 'safe' : ev.status === 'CRASH DETECTED' ? 'crash' : 'emergency';
        const color = ev.status === 'SAFE' ? '#00f5a0' : ev.status === 'CRASH DETECTED' ? '#f5a623' : '#ff3860';
        return `<div class="event-row"><div class="event-dot ${cls}"></div><div class="event-info"><div class="event-status" style="color:${color}">${ev.status}</div><div class="event-time">${ev.time.toLocaleTimeString()}</div></div>${ev.gforce ? `<span style="font-family:var(--mono);font-size:0.75rem;color:var(--text3);">${parseFloat(ev.gforce).toFixed(2)}G</span>` : ''}</div>`;
    }).join('');
}

// ═══════════════════════════════════════
//  LOCATION
// ═══════════════════════════════════════
function startLocationTracking() {
    if (!('geolocation' in navigator)) return;
    state.locationWatcher = navigator.geolocation.watchPosition(pos => {
        state.location.lat = pos.coords.latitude;
        state.location.lng = pos.coords.longitude;
        state.location.accuracy = pos.coords.accuracy;
        updateLocationUI();
        if (uid && db) {
            db.ref(`/users/${uid}/location`).set({
                lat: state.location.lat, lng: state.location.lng,
                accuracy: state.location.accuracy, timestamp: Date.now()
            });
        }
    }, err => console.warn('Location error:', err.message),
        { enableHighAccuracy: true, maximumAge: 15000, timeout: 10000 });
}

function updateLocation() {
    if (!('geolocation' in navigator)) return;
    navigator.geolocation.getCurrentPosition(pos => {
        state.location.lat = pos.coords.latitude;
        state.location.lng = pos.coords.longitude;
        state.location.accuracy = pos.coords.accuracy;
        updateLocationUI();
        if (state.map && state.marker) {
            state.map.setView([state.location.lat, state.location.lng], 16);
            state.marker.setLatLng([state.location.lat, state.location.lng]);
        }
        showToast('📍 Location updated!');
    }, () => showToast('Location access denied', true), { enableHighAccuracy: true, timeout: 10000 });
}

function updateLocationUI() {
    const v = {
        locLat: state.location.lat?.toFixed(6) || '--',
        locLng: state.location.lng?.toFixed(6) || '--',
        locLatDetail: state.location.lat?.toFixed(6) || '--',
        locLngDetail: state.location.lng?.toFixed(6) || '--',
        locAccuracy: state.location.accuracy ? `${state.location.accuracy.toFixed(0)}m` : '--',
        locTime: new Date().toLocaleTimeString(),
        locUpdated: new Date().toLocaleTimeString()
    };
    Object.entries(v).forEach(([id, val]) => { const el = $(id); if (el) el.textContent = val; });
}

function initMap() {
    if (state.map) {
        setTimeout(() => state.map.invalidateSize(), 200);
        if (state.location.lat && state.marker) {
            state.map.setView([state.location.lat, state.location.lng], 15);
            state.marker.setLatLng([state.location.lat, state.location.lng]);
        }
        return;
    }
    const lat = state.location.lat || 12.9716, lng = state.location.lng || 77.5946;
    state.map = L.map('locationMap', { zoomControl: true }).setView([lat, lng], 15);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(state.map);
    state.marker = L.marker([lat, lng]).addTo(state.map).bindPopup('<b>Your Location</b>');
    L.circle([lat, lng], { radius: state.location.accuracy || 100, color: '#00d9f5', fillOpacity: 0.1 }).addTo(state.map);
    setTimeout(() => state.map.invalidateSize(), 300);
}

// ═══════════════════════════════════════
//  FAMILY / CONTACTS
// ═══════════════════════════════════════
let editingContactIndex = -1;

function renderFamilyList() {
    const list = $('familyList'); if (!list) return;
    if (state.contacts.length === 0) {
        list.innerHTML = '<div style="text-align:center;padding:1.5rem;color:var(--text3);"><i class="fas fa-users-slash" style="font-size:1.5rem;display:block;margin-bottom:0.5rem;"></i>No contacts added yet</div>';
        return;
    }
    const colors = ['c1', 'c2', 'c3'], icons = ['fas fa-user-tie', 'fas fa-user', 'fas fa-user'];
    list.innerHTML = state.contacts.map((c, i) => `
        <div class="family-contact" onclick="openContactModal(${i})">
            <div class="contact-avatar-circle ${colors[i % 3]}"><i class="${icons[i % 3]}"></i></div>
            <div class="family-contact-info"><strong>${c.name}</strong><span>+91 ${c.phone}</span></div>
            <span class="family-contact-relation">${c.relation}</span>
        </div>`).join('');
}

function openContactModal(index) {
    editingContactIndex = index !== undefined ? index : -1;
    const modal = $('contactModal'); if (!modal) return;
    modal.classList.add('active');
    if (editingContactIndex >= 0) {
        const c = state.contacts[editingContactIndex];
        $('contactModalTitle').innerHTML = '<i class="fas fa-user-pen"></i> Edit Contact';
        $('modalContactName').value = c.name; $('modalContactPhone').value = c.phone; $('modalContactRelation').value = c.relation;
        $('deleteContactBtn').style.display = 'flex';
    } else {
        $('contactModalTitle').innerHTML = '<i class="fas fa-user-plus"></i> Add Contact';
        $('modalContactName').value = ''; $('modalContactPhone').value = ''; $('modalContactRelation').value = 'Father';
        $('deleteContactBtn').style.display = 'none';
    }
}

function closeContactModal() { const m = $('contactModal'); if (m) m.classList.remove('active'); }

function saveContact() {
    const name = $('modalContactName').value.trim(), phone = $('modalContactPhone').value.trim(), relation = $('modalContactRelation').value;
    if (!name || !phone || phone.length !== 10) { showToast('Enter valid name and 10-digit number', true); return; }
    const contact = { name, phone, relation };
    if (editingContactIndex >= 0) state.contacts[editingContactIndex] = contact;
    else state.contacts.push(contact);
    saveContactsToStorage(); closeContactModal(); renderFamilyList(); showToast('✅ Contact saved!');
}

function deleteContact() {
    if (editingContactIndex >= 0) {
        state.contacts.splice(editingContactIndex, 1);
        saveContactsToStorage(); closeContactModal(); renderFamilyList(); showToast('Contact deleted');
    }
}

function saveContactsToStorage() {
    localStorage.setItem('helmetguard_contacts', JSON.stringify(state.contacts));
    if (uid && db) db.ref(`/users/${uid}/contacts`).set(state.contacts);
}

// ═══════════════════════════════════════
//  EMERGENCY ALERT (SENDS ONLY ONCE!)
// ═══════════════════════════════════════
async function triggerEmergencyAlert(data) {
    console.log('🚨 TRIGGERING EMERGENCY ALERT...');

    // Wait for location if needed
    if (!state.location.lat) {
        await new Promise(resolve => {
            if ('geolocation' in navigator) {
                navigator.geolocation.getCurrentPosition(pos => {
                    state.location.lat = pos.coords.latitude;
                    state.location.lng = pos.coords.longitude;
                    state.location.accuracy = pos.coords.accuracy;
                    resolve();
                }, () => resolve(), { enableHighAccuracy: true, timeout: 5000 });
            } else resolve();
        });
    }

    const lat = state.location.lat, lng = state.location.lng;
    const mapLink = lat ? `https://maps.google.com/maps?q=${lat},${lng}` : 'Location unavailable';

    // Save to Firebase
    if (uid && db) {
        const eData = {
            timestamp: Date.now(), time_readable: new Date().toLocaleString('en-IN'),
            riderName: state.user?.name || 'Unknown', riderPhone: state.user?.phone || 'Unknown',
            bloodGroup: state.user?.blood || 'Unknown', vehicle: state.user?.vehicle || 'Unknown',
            crashGforce: data.crash_gforce || data.live_gforce || '--',
            location: { lat: lat || 'Unknown', lng: lng || 'Unknown' },
            mapLink, status: 'EMERGENCY', contactCount: state.contacts.length
        };
        db.ref('/emergencies').push(eData);
        db.ref(`/users/${uid}/emergencies`).push(eData);
    }

    // Send SMS via Backend
    if (state.contacts.length > 0) {
        try {
            showToast('📤 Sending emergency SMS...');
            const response = await fetch(`${BACKEND_URL}/api/send-emergency-sms`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    riderName: state.user?.name || 'Unknown Rider',
                    riderPhone: state.user?.phone || '',
                    bloodGroup: state.user?.blood || 'Unknown',
                    vehicle: state.user?.vehicle || 'Unknown',
                    crashGforce: String(data.crash_gforce || data.live_gforce || '--'),
                    latitude: lat || null, longitude: lng || null,
                    contacts: state.contacts
                })
            });
            const result = await response.json();
            if (result.success) {
                const sent = result.results.filter(r => r.status === 'sent').length;
                const failed = result.results.filter(r => r.status === 'failed');
                if (failed.length > 0) {
                    const names = failed.map(r => r.contact).join(', ');
                    showToast(`SMS sent to ${sent}/${state.contacts.length}. Failed: ${names}`, true);
                    failed.forEach(r => console.error(`SMS FAILED for ${r.contact}: ${r.error}`));
                } else {
                    showToast(`✅ Emergency SMS sent to all ${sent} contacts!`);
                }
            } else {
                showToast('❌ SMS sending failed', true);
            }
        } catch (err) {
            console.error('Backend error:', err);
            showToast('❌ Server unreachable — trying fallback...', true);
            fallbackSMS(data, mapLink);
        }
    } else {
        showToast('⚠ No emergency contacts!', true);
    }

    showEmergencyNotification();
}

function fallbackSMS(data, mapLink) {
    const body = encodeURIComponent(
        `🚨 EMERGENCY — HelmetGuard\n\n${state.user?.name || 'A rider'} may have had an accident!\n\nNo response within 15 seconds.\n📍 Location: ${mapLink}\n💥 Impact: ${data.crash_gforce || data.live_gforce || '--'}G\n🩸 Blood: ${state.user?.blood || 'Unknown'}\n🕐 Time: ${new Date().toLocaleString()}\n\nPlease check immediately or call 108.`
    );
    state.contacts.forEach((c, i) => {
        setTimeout(() => window.open(`sms:+91${c.phone}?body=${body}`, '_blank'), i * 800);
    });
}

// ═══════════════════════════════════════
//  SHARE LOCATION (via Backend SMS)
// ═══════════════════════════════════════
async function shareLocationWithFamily() {
    if (!state.location.lat) { showToast('📍 Location not available yet', true); return; }
    if (state.contacts.length === 0) { showToast('No contacts to share with', true); return; }
    showToast('📤 Sharing location...');
    try {
        const res = await fetch(`${BACKEND_URL}/api/share-location`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ riderName: state.user?.name || 'Rider', latitude: state.location.lat, longitude: state.location.lng, contacts: state.contacts })
        });
        const result = await res.json();
        if (result.success) {
            const sent = result.results.filter(r => r.status === 'sent').length;
            showToast(`📍 Location shared with ${sent} contacts!`);
        } else showToast('Failed to share', true);
    } catch (err) {
        const link = `https://maps.google.com/maps?q=${state.location.lat},${state.location.lng}`;
        const msg = encodeURIComponent(`📍 ${state.user?.name || 'Rider'}'s Location:\n${link}\n\nVia HelmetGuard`);
        if (state.contacts.length > 0) window.open(`sms:+91${state.contacts[0].phone}?body=${msg}`, '_blank');
        showToast('Server offline — opening SMS', true);
    }
}

// ═══════════════════════════════════════
//  BACKEND STATUS
// ═══════════════════════════════════════
async function checkBackendStatus() {
    const el = $('profServerStatus'); if (!el) return;
    try {
        const res = await fetch(`${BACKEND_URL}/`, { signal: AbortSignal.timeout(5000) });
        const data = await res.json();
        if (data.status === 'running') {
            el.textContent = data.twilio === 'connected' ? 'Connected' : 'No Twilio';
            el.style.color = data.twilio === 'connected' ? '#4ADE80' : '#FBBF24';
        }
    } catch { el.textContent = 'Offline'; el.style.color = '#F87171'; }
}

// ═══════════════════════════════════════
//  PROFILE UI
// ═══════════════════════════════════════
function updateProfileUI() {
    if (!state.user) return;
    const u = {
        profileName: state.user.name || '--', profilePhone: state.user.phone ? '+91 ' + state.user.phone : '--',
        profName: state.user.name || '--', profPhone: state.user.phone ? '+91 ' + state.user.phone : '--',
        profBlood: state.user.blood || '--', profVehicle: state.user.vehicle || '--'
    };
    Object.entries(u).forEach(([id, val]) => { const el = $(id); if (el) el.textContent = val; });
}

// ═══════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════
let toastTimeout = null;
function showToast(msg, isError = false) {
    const t = $('toast'); if (!t) return;
    if (toastTimeout) clearTimeout(toastTimeout);
    const msgEl = t.querySelector('#toastMsg'), iconEl = t.querySelector('i');
    if (msgEl) msgEl.textContent = msg;
    if (iconEl) iconEl.className = isError ? 'fas fa-exclamation-circle' : 'fas fa-check-circle';
    t.className = 'toast show' + (isError ? ' error' : '');
    toastTimeout = setTimeout(() => t.classList.remove('show'), 3000);
}

function playVibrate() { try { if ('vibrate' in navigator) navigator.vibrate([300, 100, 300, 100, 300]); } catch (e) { } }

function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
}

function showEmergencyNotification() {
    if ('Notification' in window && Notification.permission === 'granted') {
        try { new Notification('🚨 HelmetGuard EMERGENCY', { body: `${state.user?.name || 'Rider'} may have had an accident! Contacts notified.`, vibrate: [300, 100, 300] }); } catch (e) { }
    }
}
