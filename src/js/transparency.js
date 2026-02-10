// Transparency Dashboard — Supabase Real-Time Audit Log
// Subscribes to audit_trail table and shows last 10 vote txns
// Supabase JS loaded via CDN in transparency.html

var SUPABASE_URL = 'https://lwyxcndmbpotaegbzs.supabase.co';
var SUPABASE_ANON_KEY = localStorage.getItem('supabaseAnonKey') || '';

var supabaseClient = null;

function initSupabase() {
    if (window.supabase && window.supabase.createClient) {
        supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        return true;
    }
    return false;
}

// Max rows to display
var MAX_ROWS = 10;

// =====================
// Load initial data
// =====================
async function loadAuditTrail() {
    var tbody = document.getElementById('auditBody');
    var statusEl = document.getElementById('statusMsg');

    if (!supabaseClient) {
        statusEl.textContent = 'Supabase not configured. Set your anon key in localStorage.';
        statusEl.style.color = '#ff5252';
        return;
    }

    try {
        var result = await supabaseClient
            .from('audit_trail')
            .select('*')
            .order('timestamp', { ascending: false })
            .limit(MAX_ROWS);

        if (result.error) {
            statusEl.textContent = 'Error loading audit data: ' + result.error.message;
            statusEl.style.color = '#ff5252';
            return;
        }

        var data = result.data;

        // Clear existing rows
        tbody.innerHTML = '';

        if (data && data.length > 0) {
            data.forEach(function (row) {
                insertRow(row, false);
            });
            statusEl.textContent = 'Showing last ' + data.length + ' transactions. Listening for new votes...';
            statusEl.style.color = '#4fc3f7';
        } else {
            statusEl.textContent = 'No votes recorded yet. Waiting for live data...';
            statusEl.style.color = '#4fc3f7';
        }
    } catch (err) {
        statusEl.textContent = 'Connection failed: ' + err.message;
        statusEl.style.color = '#ff5252';
    }
}

// =====================
// Insert a row into the table
// =====================
function insertRow(row, animate) {
    var tbody = document.getElementById('auditBody');

    var tr = document.createElement('tr');
    if (animate) {
        tr.className = 'new-row';
    }

    // Shorten hash for display
    var shortHash = row.transaction_hash
        ? row.transaction_hash.substring(0, 10) + '...' + row.transaction_hash.substring(row.transaction_hash.length - 8)
        : 'N/A';

    var ts = row.timestamp ? new Date(row.timestamp).toLocaleString() : '';

    tr.innerHTML =
        '<td class="hash-cell" title="' + (row.transaction_hash || '') + '">' + shortHash + '</td>' +
        '<td>' + (row.event_type || 'VoteCast') + '</td>' +
        '<td>' + (row.block_number || '-') + '</td>' +
        '<td>' + ts + '</td>';

    // Insert at top
    if (tbody.firstChild) {
        tbody.insertBefore(tr, tbody.firstChild);
    } else {
        tbody.appendChild(tr);
    }

    // Trim to MAX_ROWS
    while (tbody.children.length > MAX_ROWS) {
        tbody.removeChild(tbody.lastChild);
    }

    // Update live counter
    updateCounter();
}

// =====================
// Live counter
// =====================
var liveCount = 0;
function updateCounter() {
    liveCount++;
    var el = document.getElementById('liveCounter');
    if (el) {
        el.textContent = liveCount;
    }
}

// =====================
// Subscribe to real-time INSERTs
// =====================
function subscribeToAuditTrail() {
    var statusEl = document.getElementById('statusMsg');

    if (!supabaseClient) return;

    supabaseClient
        .channel('audit-realtime')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'audit_trail' }, function (payload) {
            console.log('New audit entry:', payload.new);
            insertRow(payload.new, true);
            statusEl.textContent = 'LIVE — New vote detected at ' + new Date().toLocaleTimeString();
            statusEl.style.color = '#00e676';
        })
        .subscribe(function (status) {
            if (status === 'SUBSCRIBED') {
                statusEl.textContent = 'Connected — Listening for new votes...';
                statusEl.style.color = '#00e676';
            }
        });
}

// =====================
// Init on DOM ready
// =====================
document.addEventListener('DOMContentLoaded', function () {
    if (initSupabase()) {
        loadAuditTrail();
        subscribeToAuditTrail();
    } else {
        var statusEl = document.getElementById('statusMsg');
        statusEl.textContent = 'Supabase SDK not loaded. Check your internet connection.';
        statusEl.style.color = '#ff5252';
    }
});
