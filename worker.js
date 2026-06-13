// Vestibular Assessment — API Proxy
// Secrets required: ANTHROPIC_API_KEY, CLINIKO_API_KEY, NOOKAL_API_KEY

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

function toBase64(str) {
  return btoa(str);
}

function clinikoHeaders(apiKey) {
  return {
    'Authorization': 'Basic ' + toBase64(apiKey + ':'),
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'VestibularAssessment/1.0',
  };
}

function respondJson(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}

async function nookalPost(path, params = {}, env) {
  if (!env?.NOOKAL_API_KEY) {
    throw new Error('Missing NOOKAL_API_KEY in worker environment');
  }

  const bodyParams = new URLSearchParams({ api_key: env.NOOKAL_API_KEY });
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      bodyParams.set(key, String(value));
    }
  });

  const resp = await fetch(`https://api.nookal.com/production/v2/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: bodyParams.toString()
  });

  const text = await resp.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { parsed, status: resp.status, ok: resp.ok };
}

function normalizePractitionersResponse(data) {
  if (data?.data?.results?.practitioners) return data;
  if (Array.isArray(data?.practitioners)) {
    return { data: { results: { practitioners: data.practitioners } } };
  }
  return data;
}

function normalizeAppointmentsResponse(data) {
  if (Array.isArray(data?.appointments)) return data;
  if (Array.isArray(data?.data?.results?.appointments)) {
    return { appointments: data.data.results.appointments };
  }
  return { appointments: [] };
}

function normalizePatientResponse(data, requestedId) {
  if (data?.patient) return data;
  const patients = data?.data?.results?.patients || (Array.isArray(data?.patients) ? data.patients : []);
  // Find the specific patient by ID; if not found, return undefined (caller will skip the appointment)
  const patient = requestedId
    ? patients.find(p => String(p.ID) === String(requestedId))
    : patients[0];
  return { patient };
}

function normalizeCasesResponse(data) {
  if (Array.isArray(data?.cases)) return data;
  if (Array.isArray(data?.data?.results?.cases)) {
    return { cases: data.data.results.cases };
  }
  if (Array.isArray(data?.data?.cases)) {
    return { cases: data.data.cases };
  }
  return { cases: [] };
}

export default {
  async fetch(request, env) {

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);

    // ── CLINIKO: today's appointments ──
    if (url.pathname === '/cliniko/appointments') {
      try {
        const today = new Date().toISOString().split('T')[0];
        const clinikoUrl = `https://api.au4.cliniko.com/v1/practitioners/1750479486207403869/appointments?q=starts_at:>=${today}T00:00:00Z,starts_at:<=${today}T23:59:59Z&per_page=50&sort=starts_at`;
        const resp = await fetch(clinikoUrl, { headers: clinikoHeaders(env.CLINIKO_API_KEY) });
        const text = await resp.text();
        return new Response(text, {
          status: resp.status, headers: { ...CORS, 'Content-Type': 'application/json' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500, headers: { ...CORS, 'Content-Type': 'application/json' }
        });
      }
    }

    // ── CLINIKO: patient by ID ──
    if (url.pathname.startsWith('/cliniko/patients/')) {
      try {
        const patientId = url.pathname.split('/').pop();
        const resp = await fetch(`https://api.au4.cliniko.com/v1/patients/${patientId}`, {
          headers: clinikoHeaders(env.CLINIKO_API_KEY)
        });
        const text = await resp.text();
        return new Response(text, {
          status: resp.status, headers: { ...CORS, 'Content-Type': 'application/json' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500, headers: { ...CORS, 'Content-Type': 'application/json' }
        });
      }
    }

    // ── CLINIKO: fetch attendees by URL ──
    if (url.pathname === '/cliniko/attendees') {
      try {
        const targetUrl = url.searchParams.get('url');
        if (!targetUrl) return new Response(JSON.stringify({ error: 'no url param' }), { status: 400, headers: CORS });
        const resp = await fetch(targetUrl, { headers: clinikoHeaders(env.CLINIKO_API_KEY) });
        const text = await resp.text();
        return new Response(text, { status: resp.status, headers: { ...CORS, 'Content-Type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
      }
    }

    // ── CLINIKO: push treatment note ──
    if (url.pathname === '/cliniko/treatment_notes' && request.method === 'POST') {
      try {
        const body = await request.json();

        const patientId = body.patientUrl.split('/').pop();
        const bookingId = body.bookingUrl ? body.bookingUrl.split('/').pop() : null;
        const attendeeId = body.attendeeUrl ? body.attendeeUrl.split('/').pop() : null;

        const noteBody = {
          title: 'Vestibular Assessment',
          draft: true,
          treatment_note_template: {
            links: { self: 'https://api.au4.cliniko.com/v1/treatment_note_templates/1970930734386390661' }
          },
          practitioner: {
            links: { self: 'https://api.au4.cliniko.com/v1/practitioners/1750479486207403869' }
          },
          patient_id: patientId,
          ...(bookingId ? { booking_id: bookingId } : {}),
          ...(attendeeId ? { attendee_id: attendeeId } : {}),
          content: {
            sections: [
              {
                name: 'Clinical',
                questions: [{ name: 'History & Referral', type: 'paragraph', answer: `<p>${(body.historyReferral || '').replace(/\n/g, '</p><p>')}</p>` }]
              },
              {
                name: 'Findings',
                questions: [{ name: 'Test Results', type: 'paragraph', answer: `<p>${(body.testResults || '').replace(/\n/g, '</p><p>')}</p>` }]
              },
              {
                name: 'Report',
                questions: [{ name: 'Report Letter', type: 'paragraph', answer: `<p>${(body.reportLetter || '').replace(/\n/g, '</p><p>')}</p>` }]
              }
            ]
          }
        };

        const resp = await fetch('https://api.au4.cliniko.com/v1/treatment_notes', {
          method: 'POST',
          headers: clinikoHeaders(env.CLINIKO_API_KEY),
          body: JSON.stringify(noteBody)
        });
        const text = await resp.text();
        let data;
        try { data = JSON.parse(text); } catch { data = { raw: text }; }
        return new Response(JSON.stringify(data), {
          status: resp.status, headers: { ...CORS, 'Content-Type': 'application/json' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500, headers: { ...CORS, 'Content-Type': 'application/json' }
        });
      }
    }

    // ── NOOKAL: practitioners ──
    if (url.pathname === '/nookal/practitioners' && request.method === 'GET') {
      try {
        const { parsed, status, ok } = await nookalPost('getPractitioners', {}, env);
        return respondJson(normalizePractitionersResponse(parsed), ok ? status : status);
      } catch (err) {
        return respondJson({ error: err.message }, 500);
      }
    }

    // ── NOOKAL: upcoming appointments (next 14 days) with patient names resolved ──
    if (url.pathname === '/nookal/appointments' && request.method === 'GET') {
      try {
        const practitionerId = url.searchParams.get('practitioner_id');
        const today = new Date();
        const fromDate = today.toISOString().split('T')[0];
        const toDate = new Date(today.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

        const apptResult = await nookalPost('getAppointments', {
          practitioner_id: practitionerId,
          date_from: fromDate,
          date_to: toDate
        }, env);

        const appointments = apptResult.parsed?.data?.results?.appointments || [];

        // Fetch each unique patient by ID using searchPatients
        const uniquePatientIds = [...new Set(appointments.map(a => a.patientID).filter(Boolean))];
        const patientResults = await Promise.all(
          uniquePatientIds.map(id => nookalPost('searchPatients', { patient_id: id }, env))
        );

        const patientMap = {};
        patientResults.forEach(r => {
          const patients = r.parsed?.data?.results?.patients || [];
          patients.forEach(p => { if (p.ID) patientMap[String(p.ID)] = p; });
        });

        const enriched = appointments
          .map(a => ({ ...a, patient: patientMap[String(a.patientID)] || null }))
          .filter(a => a.patient !== null);

        return respondJson({ appointments: enriched }, apptResult.ok ? apptResult.status : 500);
      } catch (err) {
        return respondJson({ error: err.message }, 500);
      }
    }

    // ── NOOKAL: single patient by ID ──
    if (url.pathname === '/nookal/patient' && request.method === 'GET') {
      try {
        const patientId = url.searchParams.get('patient_id');
        if (!patientId) {
          return respondJson({ error: 'patient_id is required' }, 400);
        }
        const { parsed, status, ok } = await nookalPost('getPatients', {
          patientID: patientId
        }, env);
        return respondJson(normalizePatientResponse(parsed, patientId), ok ? status : status);
      } catch (err) {
        return respondJson({ error: err.message }, 500);
      }
    }

    // ── NOOKAL: cases for patient ──
    if (url.pathname === '/nookal/cases' && request.method === 'GET') {
      try {
        const patientId = url.searchParams.get('patient_id');
        if (!patientId) {
          return respondJson({ error: 'patient_id is required' }, 400);
        }
        const { parsed, status, ok } = await nookalPost('getCases', {
          patient_id: patientId
        }, env);
        return respondJson(normalizeCasesResponse(parsed), ok ? status : status);
      } catch (err) {
        return respondJson({ error: err.message }, 500);
      }
    }

    // ── NOOKAL: search patients ──
    if (url.pathname === '/nookal/search' && request.method === 'GET') {
      try {
        const fname = url.searchParams.get('fname') || '';
        const lname = url.searchParams.get('lname') || '';

        if (!fname && !lname) {
          return new Response(JSON.stringify({ error: 'At least one of fname or lname is required' }), {
            status: 400, headers: { ...CORS, 'Content-Type': 'application/json' }
          });
        }

        const body = new URLSearchParams({ api_key: env.NOOKAL_API_KEY });
        if (fname) body.set('first_name', fname);
        if (lname) body.set('last_name', lname);

        const nookalResp = await fetch('https://api.nookal.com/production/v2/searchPatients', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString()
        });

        const data = await nookalResp.json().catch(() => ({}));
        return new Response(JSON.stringify(data), {
          status: nookalResp.ok ? 200 : nookalResp.status,
          headers: { ...CORS, 'Content-Type': 'application/json' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500, headers: { ...CORS, 'Content-Type': 'application/json' }
        });
      }
    }

    // ── NOOKAL: add treatment note ──
    if (url.pathname === '/nookal/treatment_note' && request.method === 'POST') {
      try {
        if (!env?.NOOKAL_API_KEY) {
          return respondJson({ error: 'Missing NOOKAL_API_KEY in worker environment' }, 500);
        }

        const req = await request.json().catch(() => ({}));

        if (!req.patient_id || !req.html || !req.practitioner_id || !req.case_id) {
          return respondJson({ error: 'patient_id, practitioner_id, case_id and html are required' }, 400);
        }

        const today = new Date().toISOString().split('T')[0];
        const body = new URLSearchParams({
          api_key: env.NOOKAL_API_KEY,
          patient_id: String(req.patient_id),
          practitioner_id: String(req.practitioner_id),
          case_id: String(req.case_id),
          date: req.date || today,
          html: req.html,
          notes: req.html
        });

        const nookalResp = await fetch('https://api.nookal.com/production/v2/addTreatmentNote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString()
        });

        const data = await nookalResp.json().catch(() => ({}));
        return new Response(JSON.stringify(data), {
          status: nookalResp.ok ? 200 : nookalResp.status,
          headers: { ...CORS, 'Content-Type': 'application/json' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500, headers: { ...CORS, 'Content-Type': 'application/json' }
        });
      }
    }

    // ── ANTHROPIC: report generation ──
    if (request.method === 'POST' && (url.pathname === '/' || url.pathname === '')) {
      try {
        const body = await request.json();
        const upstream = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({...body, model: 'claude-sonnet-4-6'}),
        });
        return new Response(upstream.body, {
          status: upstream.status,
          headers: { ...CORS, 'Content-Type': upstream.headers.get('Content-Type') || 'text/event-stream' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500, headers: { ...CORS, 'Content-Type': 'application/json' }
        });
      }
    }

    return new Response('Not found', { status: 404, headers: CORS });
  }
};