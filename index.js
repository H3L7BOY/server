import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import pino from 'pino'
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  Browsers
} from 'baileys'
import QRCode from 'qrcode'
import { nanoid } from 'nanoid'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const log = pino({ level: 'info' })

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
app.use(cors())
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

const PORT = process.env.PORT || 3000

// sessions/<SESSION_ID>/ will store Baileys multi-file auth
const SESSIONS_DIR = path.join(__dirname, 'sessions')
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true })

// codes/<LUX~XXXX>.json will store creds.json (our "DB")
const CODES_DIR = path.join(__dirname, 'codes')
if (!fs.existsSync(CODES_DIR)) fs.mkdirSync(CODES_DIR, { recursive: true })

// in-memory store of: sessionId -> shortCode (LUX~XXXXXXXX)
const sessionResults = new Map()

// generate LUX short code, e.g. LUX~aB3Xd91K
function generateShortCode() {
  return 'LUX~' + nanoid(8)
}

// read creds.json and store it under a LUX~ code in codes/
function storeSessionAndCode(sessionId, sessionPath) {
  try {
    const credsPath = path.join(sessionPath, 'creds.json')
    if (!fs.existsSync(credsPath)) {
      log.warn({ sessionId }, 'creds.json not found yet')
      return null
    }

    const credsJson = fs.readFileSync(credsPath, 'utf8')

    // reuse existing code for this session if present
    let shortCode = sessionResults.get(sessionId)
    if (!shortCode) {
      shortCode = generateShortCode()
      sessionResults.set(sessionId, shortCode)
    }

    const codeFile = path.join(CODES_DIR, `${shortCode}.json`)
    fs.writeFileSync(codeFile, credsJson, 'utf8')

    log.info({ sessionId, shortCode }, 'Stored creds under short code (file DB)')
    return shortCode
  } catch (err) {
    log.error({ err, sessionId }, 'failed to store session code in file DB')
    return null
  }
}

// create a Baileys socket bound to a specific sessionId (multi-file auth)
async function createSocket(sessionId) {
  const sessionPath = path.join(SESSIONS_DIR, sessionId)
  if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true })

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath)

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome') // same style many bots use
  })

  // keep auth up to date & rebuild short code when creds change
  sock.ev.on('creds.update', async () => {
    await saveCreds()
    storeSessionAndCode(sessionId, sessionPath)
    log.info({ sessionId }, 'creds updated & saved')
  })

  // generic logging for connection updates
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update
    log.info(
      {
        sessionId,
        connection,
        statusCode: lastDisconnect?.error?.output?.statusCode
      },
      'connection.update (generic)'
    )
  })

  return { sock, sessionPath }
}

/**
 * QR LOGIN
 * GET /api/session/qr
 * -> returns a base64 PNG QR, + sessionId
 */
app.get('/api/session/qr', async (req, res) => {
  const sessionId = 'S-' + nanoid(10)
  log.info({ sessionId }, 'QR session requested')

  try {
    const { sock } = await createSocket(sessionId)

    let answered = false

    const timeout = setTimeout(() => {
      if (!answered) {
        answered = true
        log.warn({ sessionId }, 'QR timeout')
        res.status(504).json({ error: 'QR timeout' })
        try {
          sock.ws?.close()
        } catch {}
      }
    }, 60_000)

    sock.ev.on('connection.update', async (update) => {
      const { qr, connection, lastDisconnect } = update

      log.info(
        {
          sessionId,
          connection,
          hasQr: !!qr,
          statusCode: lastDisconnect?.error?.output?.statusCode
        },
        'connection.update (qr)'
      )

      if (!answered && qr) {
        const dataUrl = await QRCode.toDataURL(qr, { width: 300 })
        answered = true
        clearTimeout(timeout)
        log.info({ sessionId }, 'QR generated')
        return res.json({
          sessionId,
          qr: dataUrl,
          status: 'scan_pending'
        })
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut
        log.warn({ sessionId, statusCode }, 'QR connection closed')

        if (!answered) {
          answered = true
          clearTimeout(timeout)
          return res.status(500).json({
            error: 'connection_closed',
            statusCode,
            shouldReconnect
          })
        }
      }
    })
  } catch (err) {
    log.error({ err, sessionId }, 'Error in /api/session/qr')
    return res.status(500).json({
      error: 'internal_error',
      details: String(err?.message || err)
    })
  }
})

/**
 * PAIR-CODE LOGIN (Baileys v7 with timed retries, zenxz/azzam style)
 * GET /api/session/pair?phone=XXXXXXXXXXX
 */
app.get('/api/session/pair', async (req, res) => {
  const rawPhone = (req.query.phone || '').toString().trim()
  const phoneDigits = rawPhone.replace(/[^\d]/g, '')

  if (!/^\d{8,15}$/.test(phoneDigits)) {
    return res.status(400).json({
      error: 'invalid_phone',
      message: 'phone must be digits only, E.164 without + (ex: 918888888888)'
    })
  }

  const sessionId = 'P-' + nanoid(10)
  log.info({ sessionId, phoneDigits }, 'Pair-code session requested (baileys v7 timed)')

  try {
    const { sock } = await createSocket(sessionId)

    let answered = false
    let attempts = 0
    const maxAttempts = 4          // how many times to try
    const intervalMs = 5000        // 5 seconds between tries

    const overallTimeout = setTimeout(() => {
      if (!answered) {
        answered = true
        log.warn({ sessionId }, 'Pair-code overall timeout')
        res.status(504).json({ error: 'pair_timeout' })
        try {
          sock.ws?.close()
        } catch {}
      }
    }, 60_000)

    const stopAll = () => {
      clearTimeout(overallTimeout)
      if (intervalId) clearInterval(intervalId)
    }

    // just for logging / debugging
    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update
      log.info(
        {
          sessionId,
          phoneDigits,
          connection,
          hasQr: !!qr,
          statusCode: lastDisconnect?.error?.output?.statusCode
        },
        'connection.update (pair)'
      )

      // if WA closes us before we manage to respond
      if (!answered && connection === 'close') {
        answered = true
        stopAll()
        const statusCode = lastDisconnect?.error?.output?.statusCode
        log.warn({ sessionId, statusCode }, 'Pair connection closed before code')
        return res.status(500).json({
          error: 'connection_closed',
          statusCode,
          shouldReconnect: statusCode !== DisconnectReason.loggedOut
        })
      }
    })

    // 🔥 interval-based pairing code request (zenxz / azzam style)
    const tryRequestCode = async () => {
      if (answered) return
      attempts += 1

      log.info({ sessionId, phoneDigits, attempts }, 'Attempting requestPairingCode')

      try {
        let code = await sock.requestPairingCode(phoneDigits)

        if (code && typeof code === 'string') {
          code = code.match(/.{1,4}/g)?.join('-') || code
        }

        if (!answered) {
          answered = true
          stopAll()
          log.info({ sessionId, phoneDigits, code }, 'Pairing code generated (baileys v7 timed)')
          return res.json({
            sessionId,
            phone: phoneDigits,
            code,
            status: 'pair_code_generated'
          })
        }
      } catch (err) {
        log.error(
          {
            sessionId,
            phoneDigits,
            attempts,
            errMessage: err?.message,
            errStack: err?.stack
          },
          'requestPairingCode error (baileys v7 timed)'
        )

        // if we already answered or hit max attempts, give up
        if (!answered && attempts >= maxAttempts) {
          answered = true
          stopAll()
          return res.status(500).json({
            error: 'pair_code_error',
            message: 'Failed to generate pair code after retries',
            details: err?.message || String(err)
          })
        }
      }
    }

    // start interval after a short initial delay (give WA time to handshake)
    const intervalId = setInterval(tryRequestCode, intervalMs)
    // optional: first try after 3 seconds instead of immediately
    setTimeout(tryRequestCode, 3000)
  } catch (err) {
    log.error(
      {
        sessionId,
        phoneDigits,
        errMessage: err?.message,
        errStack: err?.stack
      },
      'Error in /api/session/pair root try (baileys v7 timed)'
    )

    return res.status(500).json({
      error: 'pair_code_error',
      message: 'Failed to generate pair code (root try)',
      details: err?.message || String(err)
    })
  }
})

/**
 * RESULT POLLING
 * GET /api/session/result/:id
 * -> returns short LUX~XXXXXX code (if ready)
 */
app.get('/api/session/result/:id', (req, res) => {
  const sessionId = req.params.id
  const code = sessionResults.get(sessionId) || null

  return res.json({
    sessionId,
    ready: !!code,
    code
  })
})

/**
 * FETCH CREDS BY SHORT CODE
 * GET /api/session/creds/:code
 * -> returns stored creds.json for that LUX~ code
 */
app.get('/api/session/creds/:code', (req, res) => {
  const code = req.params.code
  const filePath = path.join(CODES_DIR, `${code}.json`)

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({
      error: 'not_found',
      message: 'No creds found for this code'
    })
  }

  try {
    const credsJson = fs.readFileSync(filePath, 'utf8')
    return res.json({
      code,
      creds: JSON.parse(credsJson)
    })
  } catch (err) {
    log.error({ err, code }, 'Error reading creds.json for code')
    return res.status(500).json({
      error: 'read_error',
      details: String(err?.message || err)
    })
  }
})

app.listen(PORT, () => {
  log.info(`LUX Session server running on port ${PORT}`)
})
