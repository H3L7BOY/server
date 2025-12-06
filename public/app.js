const API_BASE = '' // same origin

// Tab switching
const tabs = document.querySelectorAll('.tab')
const panels = {
  pair: document.getElementById('tab-pair'),
  qr: document.getElementById('tab-qr')
}

tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab

    tabs.forEach((t) => t.classList.remove('active'))
    tab.classList.add('active')

    Object.entries(panels).forEach(([name, el]) => {
      el.classList.toggle('active', name === target)
    })
  })
})

// Pair code elements
const phoneInput = document.getElementById('phone-input')
const pairBtn = document.getElementById('pair-btn')
const pairStatus = document.getElementById('pair-status')
const pairCodeContainer = document.getElementById('pair-code-container')
const pairCodeDisplay = document.getElementById('pair-code')
const luxCodeContainerPair = document.getElementById('lux-code-container-pair')
const luxCodePair = document.getElementById('lux-code-pair')
const copyLuxPair = document.getElementById('copy-lux-pair')

// QR elements
const qrBtn = document.getElementById('qr-btn')
const qrStatus = document.getElementById('qr-status')
const qrContainer = document.getElementById('qr-container')
const qrImage = document.getElementById('qr-image')
const luxCodeContainerQr = document.getElementById('lux-code-container-qr')
const luxCodeQr = document.getElementById('lux-code-qr')
const copyLuxQr = document.getElementById('copy-lux-qr')

let pollIntervalId = null

function clearPoll() {
  if (pollIntervalId) {
    clearInterval(pollIntervalId)
    pollIntervalId = null
  }
}

async function pollForLuxCode(sessionId, mode) {
  clearPoll()
  pollIntervalId = setInterval(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/session/result/${sessionId}`)
      const data = await res.json()

      if (data.ready && data.code) {
        clearPoll()
        const luxCode = data.code

        if (mode === 'pair') {
          luxCodePair.textContent = luxCode
          luxCodeContainerPair.classList.remove('hidden')
          pairStatus.textContent = 'Session code generated successfully.'
          pairStatus.className = 'status success'
        } else if (mode === 'qr') {
          luxCodeQr.textContent = luxCode
          luxCodeContainerQr.classList.remove('hidden')
          qrStatus.textContent = 'Session code generated successfully.'
          qrStatus.className = 'status success'
        }
      }
    } catch (err) {
      console.error('Polling error', err)
    }
  }, 4000)
}

// Pair code flow
pairBtn.addEventListener('click', async () => {
  const phone = phoneInput.value.trim()

  pairStatus.textContent = ''
  pairStatus.className = 'status'
  pairCodeContainer.classList.add('hidden')
  luxCodeContainerPair.classList.add('hidden')

  if (!/^\d{8,15}$/.test(phone.replace(/[^\d]/g, ''))) {
    pairStatus.textContent =
      'Invalid phone. Use digits only, E.164 format without + (ex: 918888888888).'
    pairStatus.classList.add('error')
    return
  }

  pairBtn.disabled = true
  pairStatus.textContent = 'Requesting pair code from LUX...'
  pairStatus.classList.remove('error')
  pairStatus.classList.add('success')

  try {
    const res = await fetch(
      `${API_BASE}/api/session/pair?phone=${encodeURIComponent(phone)}`
    )
    const data = await res.json()

    if (!res.ok) {
      throw new Error(data.message || data.error || 'Unknown error')
    }

    pairCodeDisplay.textContent = data.code || '----'
    pairCodeContainer.classList.remove('hidden')
    pairStatus.textContent =
      'Enter this pair code in WhatsApp → Linked devices → Link with phone number.'
    pairStatus.className = 'status success'

    if (data.sessionId) {
      pollForLuxCode(data.sessionId, 'pair')
    }
  } catch (err) {
    console.error(err)
    pairStatus.textContent = `Error: ${err.message}`
    pairStatus.className = 'status error'
  } finally {
    pairBtn.disabled = false
  }
})

// QR flow
qrBtn.addEventListener('click', async () => {
  qrStatus.textContent = ''
  qrStatus.className = 'status'
  qrContainer.classList.add('hidden')
  luxCodeContainerQr.classList.add('hidden')

  qrBtn.disabled = true
  qrStatus.textContent = 'Requesting QR from LUX...'
  qrStatus.classList.remove('error')
  qrStatus.classList.add('success')

  try {
    const res = await fetch(`${API_BASE}/api/session/qr`)
    const data = await res.json()

    if (!res.ok) {
      throw new Error(data.message || data.error || 'Unknown error')
    }

    if (data.qr) {
      qrImage.src = data.qr
      qrContainer.classList.remove('hidden')
      qrStatus.textContent =
        'Scan the QR from WhatsApp → Linked devices → Link a device.'
      qrStatus.className = 'status success'
    }

    if (data.sessionId) {
      pollForLuxCode(data.sessionId, 'qr')
    }
  } catch (err) {
    console.error(err)
    qrStatus.textContent = `Error: ${err.message}`
    qrStatus.className = 'status error'
  } finally {
    qrBtn.disabled = false
  }
})

// Copy helpers
async function copyText(text) {
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    alert('Copied to clipboard.')
  } catch {
    alert('Failed to copy, copy manually.')
  }
}

copyLuxPair.addEventListener('click', () => copyText(luxCodePair.textContent))
copyLuxQr.addEventListener('click', () => copyText(luxCodeQr.textContent))
