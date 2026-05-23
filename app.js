/**
 * VaniLink - Tamil-English Call Translator Controller
 * 100% Free, Client-side Speech Recognition, Translation, and Synthesis.
 */

// --- App State Management ---
const state = {
    callStatus: 'idle', // idle, ringing, connected, ended
    mode: 'ta-en', // ta-en (Tamil to English), en-ta (English to Tamil)
    isMuted: false, // Mutes speech synthesis output
    isListening: false,
    continuousRecognition: true,
    autoSpeak: true,
    speechRate: 1.0,
    speechPitch: 1.0,
    selectedVoiceEn: null,
    selectedVoiceTa: null,
    callDuration: 0,
    timerInterval: null,
    audioContext: null,
    ringOscillators: [],
    ringGainNode: null,
    activeUtterance: null
};

// --- DOM Reference Selectors ---
const DOM = {
    appTitle: document.getElementById('app-title'),
    btnModeTaEn: document.getElementById('btn-mode-ta-en'),
    btnModeEnTa: document.getElementById('btn-mode-en-ta'),
    btnSettingsToggle: document.getElementById('btn-settings-toggle'),
    btnVolumeToggle: document.getElementById('btn-volume-toggle'),
    volumeIcon: document.getElementById('volume-icon'),
    callTimer: document.getElementById('call-timer'),
    
    // Screens
    callOverlay: document.getElementById('call-overlay'),
    callRinging: document.getElementById('call-ringing'),
    ringingFlag: document.getElementById('ringing-flag'),
    ringingTitle: document.getElementById('ringing-title'),
    ringingSubtitle: document.getElementById('ringing-subtitle'),
    
    // Buttons
    btnInitiateCall: document.getElementById('btn-initiate-call'),
    btnCancelRing: document.getElementById('btn-cancel-ring'),
    btnMicTrigger: document.getElementById('btn-mic-trigger'),
    btnDisconnectCall: document.getElementById('btn-disconnect-call'),
    btnToggleMicMode: document.getElementById('btn-toggle-mic-mode'),
    
    // Conversation & Wave
    transcriptContainer: document.getElementById('transcript-container'),
    conversationEmptyState: document.getElementById('conversation-empty-state'),
    waveformPanel: document.getElementById('waveform-panel'),
    waveformLabel: document.getElementById('waveform-label'),
    waveContainer: document.querySelector('.wave-container'),
    avatarRing: document.querySelector('.avatar-ring'),
    
    // Fallback Input Box
    manualTextPanel: document.getElementById('manual-text-panel'),
    fallbackInputForm: document.getElementById('fallback-input-form'),
    fallbackInputField: document.getElementById('fallback-input-field'),
    
    // Quick Phrases Lists
    tamilPhrasesList: document.getElementById('tamil-phrases-list'),
    englishPhrasesList: document.getElementById('english-phrases-list'),
    tabTamilPhrases: document.getElementById('tab-tamil-phrases'),
    tabEnglishPhrases: document.getElementById('tab-english-phrases'),
    
    // Status Indicators
    statusEngine: document.getElementById('status-engine'),
    statusEngineDot: document.getElementById('status-engine-dot'),
    statusTts: document.getElementById('status-tts'),
    statusTtsDot: document.getElementById('status-tts-dot'),
    
    // Settings Modal elements
    settingsModal: document.getElementById('settings-modal'),
    btnCloseSettings: document.getElementById('btn-close-settings'),
    btnSaveSettings: document.getElementById('btn-save-settings'),
    selectEnglishVoice: document.getElementById('select-english-voice'),
    selectTamilVoice: document.getElementById('select-tamil-voice'),
    sliderSpeechRate: document.getElementById('slider-speech-rate'),
    lblSpeechRate: document.getElementById('lbl-speech-rate'),
    sliderSpeechPitch: document.getElementById('slider-speech-pitch'),
    lblSpeechPitch: document.getElementById('lbl-speech-pitch'),
    chkAutoSpeak: document.getElementById('chk-auto-speak'),
    chkContinuousMic: document.getElementById('chk-continuous-mic'),
    micHint: document.getElementById('mic-hint')
};

// --- Web Speech API Availability Checks ---
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const recognitionInstance = SpeechRecognition ? new SpeechRecognition() : null;

if (!recognitionInstance) {
    console.warn("Speech Recognition API is not supported in this browser. Fallback input will be active.");
    DOM.statusEngine.innerText = "Unsupported";
    DOM.statusEngineDot.className = "status-dot red";
}

// Ensure SpeechSynthesis is loaded
const synth = window.speechSynthesis;
let availableVoices = [];

function loadVoices() {
    if (!synth) {
        DOM.statusTts.innerText = "Unsupported";
        DOM.statusTtsDot.className = "status-dot red";
        return;
    }
    
    availableVoices = synth.getVoices();
    
    // Populate selectors
    DOM.selectEnglishVoice.innerHTML = '<option value="default">System Default (English)</option>';
    DOM.selectTamilVoice.innerHTML = '<option value="default">System Default (Tamil)</option>';
    
    let defaultEnIdx = -1;
    let defaultTaIdx = -1;
    
    availableVoices.forEach((voice, index) => {
        const option = document.createElement('option');
        option.value = index;
        option.textContent = `${voice.name} (${voice.lang})`;
        
        if (voice.lang.startsWith('en')) {
            DOM.selectEnglishVoice.appendChild(option);
            // Prefer Google US English or Microsoft English
            if (defaultEnIdx === -1 && (voice.name.includes('Google') || voice.name.includes('Natural') || voice.name.includes('Zira') || voice.name.includes('David'))) {
                defaultEnIdx = index;
            }
        } else if (voice.lang.startsWith('ta')) {
            DOM.selectTamilVoice.appendChild(option);
            defaultTaIdx = index;
        }
    });

    // Auto-select preferred voices if found
    if (defaultEnIdx !== -1) DOM.selectEnglishVoice.value = defaultEnIdx;
    if (defaultTaIdx !== -1) DOM.selectTamilVoice.value = defaultTaIdx;
}

if (synth) {
    loadVoices();
    if (speechSynthesis.onvoiceschanged !== undefined) {
        speechSynthesis.onvoiceschanged = loadVoices;
    }
}

// --- Initialize Speech Recognition Configuration ---
if (recognitionInstance) {
    recognitionInstance.continuous = false;
    recognitionInstance.interimResults = true;
    recognitionInstance.maxAlternatives = 1;
}

// --- Sound Effects Generator (Web Audio API) ---
function initAudioContext() {
    if (!state.audioContext) {
        state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (state.audioContext.state === 'suspended') {
        state.audioContext.resume();
    }
}

// Generates ringing tones (simulated telephone ring)
function startRingtoneSynth() {
    initAudioContext();
    const ctx = state.audioContext;
    
    state.ringGainNode = ctx.createGain();
    state.ringGainNode.connect(ctx.destination);
    state.ringGainNode.gain.setValueAtTime(0, ctx.currentTime);
    
    // Call sound: dual-frequency ring (440Hz + 480Hz)
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    
    osc1.frequency.value = 440;
    osc2.frequency.value = 480;
    
    osc1.connect(state.ringGainNode);
    osc2.connect(state.ringGainNode);
    
    osc1.start();
    osc2.start();
    
    state.ringOscillators = [osc1, osc2];
    
    // Play ring cycle: 2s sound, 3s silence
    let time = ctx.currentTime;
    for (let i = 0; i < 10; i++) {
        state.ringGainNode.gain.setValueAtTime(0.15, time);
        state.ringGainNode.gain.setValueAtTime(0, time + 1.8);
        time += 5; // Repeat interval
    }
}

function stopRingtoneSynth() {
    if (state.ringOscillators.length) {
        state.ringOscillators.forEach(osc => {
            try { osc.stop(); } catch(e) {}
        });
        state.ringOscillators = [];
    }
    if (state.ringGainNode) {
        try { state.ringGainNode.disconnect(); } catch(e) {}
        state.ringGainNode = null;
    }
}

// Play UI Click Beeps and Call connection cues
function playAudioCue(type) {
    try {
        initAudioContext();
        const ctx = state.audioContext;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);

        if (type === 'connect') {
            // Friendly double beep
            osc.frequency.setValueAtTime(650, ctx.currentTime);
            gain.gain.setValueAtTime(0, ctx.currentTime);
            gain.gain.linearRampToValueAtTime(0.15, ctx.currentTime + 0.05);
            gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);
            osc.start();
            
            setTimeout(() => {
                const osc2 = ctx.createOscillator();
                const gain2 = ctx.createGain();
                osc2.connect(gain2);
                gain2.connect(ctx.destination);
                osc2.frequency.setValueAtTime(850, ctx.currentTime);
                gain2.gain.setValueAtTime(0, ctx.currentTime);
                gain2.gain.linearRampToValueAtTime(0.15, ctx.currentTime + 0.05);
                gain2.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);
                osc2.start();
                osc2.stop(ctx.currentTime + 0.22);
            }, 120);
            
            osc.stop(ctx.currentTime + 0.16);
        } else if (type === 'disconnect') {
            // Three declining tones (end call sound)
            osc.frequency.setValueAtTime(520, ctx.currentTime);
            gain.gain.setValueAtTime(0.15, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);
            osc.start();
            
            setTimeout(() => {
                const osc2 = ctx.createOscillator();
                const gain2 = ctx.createGain();
                osc2.connect(gain2);
                gain2.connect(ctx.destination);
                osc2.frequency.setValueAtTime(420, ctx.currentTime);
                gain2.gain.setValueAtTime(0.15, ctx.currentTime);
                gain2.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);
                osc2.start();
                osc2.stop(ctx.currentTime + 0.16);
            }, 120);
            
            setTimeout(() => {
                const osc3 = ctx.createOscillator();
                const gain3 = ctx.createGain();
                osc3.connect(gain3);
                gain3.connect(ctx.destination);
                osc3.frequency.setValueAtTime(320, ctx.currentTime);
                gain3.gain.setValueAtTime(0.15, ctx.currentTime);
                gain3.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.25);
                osc3.start();
                osc3.stop(ctx.currentTime + 0.26);
            }, 240);

            osc.stop(ctx.currentTime + 0.16);
        } else if (type === 'click') {
            osc.frequency.setValueAtTime(800, ctx.currentTime);
            gain.gain.setValueAtTime(0.05, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.05);
            osc.start();
            osc.stop(ctx.currentTime + 0.06);
        }
    } catch (e) {
        console.error("Audio Synthesis error: ", e);
    }
}

// --- Call Timer ---
function startTimer() {
    state.callDuration = 0;
    DOM.callTimer.innerText = "00:00";
    clearInterval(state.timerInterval);
    state.timerInterval = setInterval(() => {
        state.callDuration++;
        const minutes = Math.floor(state.callDuration / 60).toString().padStart(2, '0');
        const seconds = (state.callDuration % 60).toString().padStart(2, '0');
        DOM.callTimer.innerText = `${minutes}:${seconds}`;
    }, 1000);
}

function stopTimer() {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
}

// --- UI Updates on State Change ---
function setCallStatus(newStatus) {
    state.callStatus = newStatus;
    
    // Reset listening visual tags
    DOM.btnMicTrigger.classList.remove('listening');
    
    if (newStatus === 'idle') {
        DOM.callOverlay.classList.remove('hidden');
        DOM.callRinging.classList.add('hidden');
        DOM.btnMicTrigger.disabled = true;
        DOM.btnDisconnectCall.disabled = true;
        DOM.avatarRing.className = "avatar-ring";
        DOM.micHint.innerText = "Start Call First";
        DOM.btnMicTrigger.classList.remove('call-active');
        DOM.waveformPanel.classList.add('hidden');
        stopTimer();
        stopRingtoneSynth();
        stopListening();
    } 
    else if (newStatus === 'ringing') {
        DOM.callOverlay.classList.add('hidden');
        DOM.callRinging.classList.remove('hidden');
        
        // Dynamic flags in ringing UI based on translation mode
        if (state.mode === 'ta-en') {
            DOM.ringingFlag.innerText = "🇮🇳";
            DOM.ringingTitle.innerText = "Calling Tamil Line...";
            DOM.ringingSubtitle.innerText = "Initializing Speech-to-Speech translator (Tamil ➔ English)...";
            DOM.callRinging.querySelector('.avatar-large').className = "avatar-large ringing tamil-ring";
        } else {
            DOM.ringingFlag.innerText = "🇬🇧";
            DOM.ringingTitle.innerText = "Calling English Line...";
            DOM.ringingSubtitle.innerText = "Initializing Speech-to-Speech translator (English ➔ Tamil)...";
            DOM.callRinging.querySelector('.avatar-large').className = "avatar-large ringing";
        }
        
        startRingtoneSynth();
    } 
    else if (newStatus === 'connected') {
        DOM.callOverlay.classList.add('hidden');
        DOM.callRinging.classList.add('hidden');
        DOM.btnMicTrigger.disabled = false;
        DOM.btnDisconnectCall.disabled = false;
        DOM.btnMicTrigger.classList.add('call-active');
        
        if (state.mode === 'ta-en') {
            DOM.btnMicTrigger.classList.remove('english-mic');
            DOM.avatarRing.className = "avatar-ring active tamil";
            DOM.micHint.innerText = "Tap to speak Tamil";
        } else {
            DOM.btnMicTrigger.classList.add('english-mic');
            DOM.avatarRing.className = "avatar-ring active";
            DOM.micHint.innerText = "Tap to speak English";
        }
        
        stopRingtoneSynth();
        playAudioCue('connect');
        startTimer();
        
        // Show visualizer immediately
        DOM.waveformPanel.classList.remove('hidden');
        setWaveformLabel("Call connected. Press Microphone to talk!");
        
        // Auto-trigger microphone listening after call connection beep
        setTimeout(() => {
            if (state.callStatus === 'connected') {
                startListening();
            }
        }, 800);
    }
}

// --- Formulate Free Translation API Calls ---
async function fetchTranslation(text, fromLang, toLang) {
    // googleapis free single-point translation client wrapper (100% Free, No auth keys)
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${fromLang}&tl=${toLang}&dt=t&q=${encodeURIComponent(text)}`;
    
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error("Translation API request failed");
        
        const result = await response.json();
        let translatedText = '';
        
        // Parse Google Translate nested array segments
        if (result && result[0]) {
            result[0].forEach(item => {
                if (item[0]) translatedText += item[0];
            });
        }
        return translatedText.trim();
    } catch (error) {
        console.error("Translation API failure: ", error);
        return "[Translation Error: Check internet connection]";
    }
}

// --- Text-To-Speech Synthesis ---
function speakTranslation(text, lang) {
    if (!synth || state.isMuted) return;
    
    // Stop ongoing speech
    synth.cancel();
    
    const utterance = new SpeechSynthesisUtterance(text);
    state.activeUtterance = utterance;
    
    // Config voice
    utterance.rate = state.speechRate;
    utterance.pitch = state.speechPitch;
    
    // Pick the selected voice based on target language
    if (lang === 'en') {
        if (DOM.selectEnglishVoice.value !== 'default' && availableVoices[DOM.selectEnglishVoice.value]) {
            utterance.voice = availableVoices[DOM.selectEnglishVoice.value];
        }
        utterance.lang = 'en-US';
    } else if (lang === 'ta') {
        if (DOM.selectTamilVoice.value !== 'default' && availableVoices[DOM.selectTamilVoice.value]) {
            utterance.voice = availableVoices[DOM.selectTamilVoice.value];
        }
        utterance.lang = 'ta-IN';
    }
    
    // Synthesis animation callbacks
    utterance.onstart = () => {
        DOM.waveContainer.classList.add('speaking');
        if (lang === 'ta') {
            DOM.waveContainer.classList.add('tamil-wave');
            setWaveformLabel("Speaking Tamil translation...");
        } else {
            DOM.waveContainer.classList.remove('tamil-wave');
            setWaveformLabel("Speaking English translation...");
        }
        DOM.statusTts.innerText = "Speaking";
    };
    
    utterance.onend = () => {
        DOM.waveContainer.classList.remove('speaking');
        DOM.statusTts.innerText = "Active";
        state.activeUtterance = null;
        
        // Always restart mic after TTS finishes if call is still connected
        if (state.callStatus === 'connected') {
            state.isListening = true;
            setTimeout(() => startListening(), 200);
        }
    };

    utterance.onerror = (e) => {
        console.error("Speech Synthesis Error: ", e);
        DOM.waveContainer.classList.remove('speaking');
        DOM.statusTts.innerText = "Active";
        state.activeUtterance = null;
    };
    
    synth.speak(utterance);
}

// --- Speech Recognition Triggers ---
function startListening() {
    if (!recognitionInstance || !SpeechRecognition) return;
    
    // Cancel active TTS output to avoid mic feedback loop
    if (synth && synth.speaking) {
        synth.cancel();
    }
    
    try {
        const recognitionLang = state.mode === 'ta-en' ? 'ta-IN' : 'en-US';
        recognitionInstance.lang = recognitionLang;
        
        recognitionInstance.start();
        state.isListening = true;
        DOM.isListening = true;
        
        DOM.btnMicTrigger.classList.add('listening');
        if (state.mode === 'ta-en') {
            DOM.btnMicTrigger.classList.remove('english-mic');
            setWaveformLabel("Listening for Tamil speech...");
            DOM.waveContainer.classList.add('tamil-wave');
        } else {
            DOM.btnMicTrigger.classList.add('english-mic');
            setWaveformLabel("Listening for English speech...");
            DOM.waveContainer.classList.remove('tamil-wave');
        }
        DOM.waveContainer.classList.add('speaking'); // Pulsate while waiting
        DOM.statusEngine.innerText = "Listening";
        DOM.statusEngineDot.className = "status-dot yellow";
    } catch (e) {
        console.log("Speech recognition start issue (likely already running): ", e);
    }
}

function stopListening() {
    if (!recognitionInstance) return;
    recognitionInstance.stop();
    state.isListening = false;
    DOM.btnMicTrigger.classList.remove('listening');
    DOM.waveContainer.classList.remove('speaking');
    setWaveformLabel("Mic Off");
    DOM.statusEngine.innerText = "Ready";
    DOM.statusEngineDot.className = "status-dot green";
}

// Bind Speech Recognition Events
if (recognitionInstance) {
    recognitionInstance.onresult = async (event) => {
        let interimTranscript = '';
        let finalTranscript = '';
        
        for (let i = event.resultIndex; i < event.results.length; ++i) {
            if (event.results[i].isFinal) {
                finalTranscript += event.results[i][0].transcript;
            } else {
                interimTranscript += event.results[i][0].transcript;
            }
        }
        
        // Show live spoken words on the waveform banner
        if (interimTranscript.trim()) {
            setWaveformLabel("Hearing live: " + interimTranscript);
        }
        
        if (finalTranscript.trim()) {
            processSpeechPipeline(finalTranscript);
        }
    };

    recognitionInstance.onerror = (event) => {
        console.warn("Speech Recognition error: ", event.error);
        
        if (event.error === 'not-allowed') {
            // Hard stop — mic permission denied
            setWaveformLabel("Microphone Permission Denied. Please allow mic access.");
            DOM.statusEngine.innerText = "Blocked";
            DOM.statusEngineDot.className = "status-dot red";
            state.isListening = false;
            DOM.btnMicTrigger.classList.remove('listening');
            DOM.waveContainer.classList.remove('speaking');
            return;
        }
        
        // For no-speech or other transient errors, just silently restart
        if (state.callStatus === 'connected' && !synth.speaking) {
            setTimeout(() => startListening(), 300);
        }
    };

    recognitionInstance.onend = () => {
        // Auto-restart mic if call is connected and TTS is not currently playing
        if (state.callStatus === 'connected' && !synth.speaking) {
            setTimeout(() => startListening(), 200);
        }
    };
}

// --- Main Text/Speech Processing Pipeline ---
async function processSpeechPipeline(textInput) {
    const fromLang = state.mode === 'ta-en' ? 'ta' : 'en';
    const toLang = state.mode === 'ta-en' ? 'en' : 'ta';
    const sourceNodeClass = state.mode === 'ta-en' ? 'self' : 'remote';
    
    // Update visualizer state to translating
    setWaveformLabel("Translating...");
    DOM.statusEngine.innerText = "Translating";
    
    // Run translation API (Free)
    const translatedResult = await fetchTranslation(textInput, fromLang, toLang);
    
    // Output dialogue node HTML
    appendDialogueBubble(textInput, translatedResult, sourceNodeClass);
    
    DOM.statusEngine.innerText = "Ready";
    if (state.isListening) {
        DOM.statusEngineDot.className = "status-dot yellow";
    }
    
    // Run Voice Output (Speech Synthesis)
    if (state.autoSpeak) {
        speakTranslation(translatedResult, toLang);
    } else {
        setWaveformLabel(state.isListening ? "Listening for voice..." : "Idle");
        if (state.continuousRecognition && state.isListening) {
            startListening();
        }
    }
}

// Render dynamic dialog bubbles in the UI
function appendDialogueBubble(sourceText, translatedText, senderClass) {
    // Hide empty transcript state
    DOM.conversationEmptyState.classList.add('hidden');
    
    const node = document.createElement('article');
    node.className = `dialogue-node ${senderClass}`;
    
    const isTamilSource = (senderClass === 'self');
    const sourceLangTag = isTamilSource ? 'Tamil 🇮🇳' : 'English 🇬🇧';
    const targetLangTag = isTamilSource ? 'English 🇬🇧' : 'Tamil 🇮🇳';
    
    // Get timestamp
    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    
    // Prioritize translated text as primary, original as smaller secondary sub-text
    node.innerHTML = `
        <div class="bubble-meta">
            <span class="bubble-lang-tag">${targetLangTag} (Translation)</span>
            <span class="bubble-time">${timeStr}</span>
        </div>
        <div class="bubble-body">
            <div class="translated-text-row">
                <p class="translated-text">${translatedText}</p>
                <button class="btn-speak-text" title="Read Translation Aloud">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
                </button>
            </div>
            <div class="translated-divider"></div>
            <p class="source-text">Original: <span>${sourceText}</span></p>
        </div>
    `;
    
    // Listen to play speaker button
    node.querySelector('.btn-speak-text').addEventListener('click', (e) => {
        e.stopPropagation();
        playAudioCue('click');
        const targetLang = isTamilSource ? 'en' : 'ta';
        speakTranslation(translatedText, targetLang);
    });
    
    DOM.transcriptContainer.appendChild(node);
    
    // Smooth scroll to bottom
    DOM.transcriptContainer.scrollTop = DOM.transcriptContainer.scrollHeight;
}

function setWaveformLabel(text) {
    DOM.waveformLabel.innerText = text;
}

// --- Bind Interactive Click Events ---

// Start call button (triggering dialing state, then connect delay)
DOM.btnInitiateCall.addEventListener('click', () => {
    playAudioCue('click');
    setCallStatus('ringing');
    
    // Simulate connection delay of 3 seconds
    setTimeout(() => {
        if (state.callStatus === 'ringing') {
            setCallStatus('connected');
        }
    }, 3000);
});

// Cancel Ringing dial
DOM.btnCancelRing.addEventListener('click', () => {
    playAudioCue('click');
    setCallStatus('idle');
});

// End Call button click
DOM.btnDisconnectCall.addEventListener('click', () => {
    playAudioCue('disconnect');
    setCallStatus('idle');
});

// Microphone toggle
DOM.btnMicTrigger.addEventListener('click', () => {
    playAudioCue('click');
    
    if (!recognitionInstance) {
        alert("Speech Recognition API is not supported in this browser. Please use the Text Input Fallback.");
        return;
    }
    
    if (state.isListening) {
        stopListening();
    } else {
        startListening();
    }
});

// Translation direction mode selectors
DOM.btnModeTaEn.addEventListener('click', () => {
    playAudioCue('click');
    if (state.mode === 'ta-en') return;
    
    state.mode = 'ta-en';
    DOM.btnModeTaEn.classList.add('active');
    DOM.btnModeEnTa.classList.remove('active');
    
    // Modify fallback placeholder
    DOM.fallbackInputField.placeholder = "Type text in Tamil to translate to English...";
    
    if (state.callStatus === 'connected') {
        DOM.btnMicTrigger.classList.remove('english-mic');
        DOM.avatarRing.className = "avatar-ring active tamil";
        DOM.micHint.innerText = "Tap to speak Tamil";
        if (state.isListening) {
            stopListening();
            startListening();
        }
    }
});

DOM.btnModeEnTa.addEventListener('click', () => {
    playAudioCue('click');
    if (state.mode === 'en-ta') return;
    
    state.mode = 'en-ta';
    DOM.btnModeEnTa.classList.add('active');
    DOM.btnModeTaEn.classList.remove('active');
    
    // Modify fallback placeholder
    DOM.fallbackInputField.placeholder = "Type text in English to translate to Tamil...";
    
    if (state.callStatus === 'connected') {
        DOM.btnMicTrigger.classList.add('english-mic');
        DOM.avatarRing.className = "avatar-ring active";
        DOM.micHint.innerText = "Tap to speak English";
        if (state.isListening) {
            stopListening();
            startListening();
        }
    }
});

// Mute Synthesized Voices
DOM.btnVolumeToggle.addEventListener('click', () => {
    state.isMuted = !state.isMuted;
    playAudioCue('click');
    
    if (state.isMuted) {
        DOM.btnVolumeToggle.classList.add('active-mute');
        DOM.volumeIcon.innerHTML = `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>`;
        if (synth && synth.speaking) synth.cancel();
    } else {
        DOM.btnVolumeToggle.classList.remove('active-mute');
        DOM.volumeIcon.innerHTML = `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>`;
    }
});

// Settings Dialog Modal Toggles
DOM.btnSettingsToggle.addEventListener('click', () => {
    playAudioCue('click');
    DOM.settingsModal.classList.remove('hidden');
});

DOM.btnCloseSettings.addEventListener('click', () => {
    playAudioCue('click');
    DOM.settingsModal.classList.add('hidden');
});

DOM.btnSaveSettings.addEventListener('click', () => {
    playAudioCue('click');
    DOM.settingsModal.classList.add('hidden');
});

// Close settings if clicking overlay bg
DOM.settingsModal.addEventListener('click', (e) => {
    if (e.target === DOM.settingsModal) {
        DOM.settingsModal.classList.add('hidden');
    }
});

// Speed slider
DOM.sliderSpeechRate.addEventListener('input', (e) => {
    state.speechRate = parseFloat(e.target.value);
    DOM.lblSpeechRate.innerText = `${state.speechRate.toFixed(1)}x`;
});

// Pitch slider
DOM.sliderSpeechPitch.addEventListener('input', (e) => {
    state.speechPitch = parseFloat(e.target.value);
    DOM.lblSpeechPitch.innerText = `${state.speechPitch.toFixed(1)}`;
});

// Settings checkboxes
DOM.chkAutoSpeak.addEventListener('change', (e) => {
    state.autoSpeak = e.target.checked;
});

DOM.chkContinuousMic.addEventListener('change', (e) => {
    state.continuousRecognition = e.target.checked;
    if (recognitionInstance) {
        recognitionInstance.continuous = state.continuousRecognition;
    }
});

// Fallback Text input toggle drawer
DOM.btnToggleMicMode.addEventListener('click', () => {
    playAudioCue('click');
    DOM.manualTextPanel.classList.toggle('hidden');
    DOM.btnToggleMicMode.classList.toggle('active-mute');
    if (!DOM.manualTextPanel.classList.contains('hidden')) {
        DOM.fallbackInputField.focus();
    }
});

// Form submission for manual text input translation
DOM.fallbackInputForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const textVal = DOM.fallbackInputField.value.trim();
    if (!textVal) return;
    
    playAudioCue('click');
    DOM.fallbackInputField.value = '';
    
    processSpeechPipeline(textVal);
});

// --- Quick Voice Phrases handlers ---

// Tab selectors (Tamil/English phrases)
DOM.tabTamilPhrases.addEventListener('click', () => {
    playAudioCue('click');
    DOM.tabTamilPhrases.classList.add('active');
    DOM.tabEnglishPhrases.classList.remove('active');
    DOM.tamilPhrasesList.classList.remove('hidden');
    DOM.englishPhrasesList.classList.add('hidden');
});

DOM.tabEnglishPhrases.addEventListener('click', () => {
    playAudioCue('click');
    DOM.tabEnglishPhrases.classList.add('active');
    DOM.tabTamilPhrases.classList.remove('active');
    DOM.englishPhrasesList.classList.remove('hidden');
    DOM.tamilPhrasesList.classList.add('hidden');
});

// Quick Phrases click trigger
document.querySelectorAll('.phrase-pill').forEach(pill => {
    pill.addEventListener('click', () => {
        playAudioCue('click');
        const textVal = pill.getAttribute('data-text');
        
        // Override state mode matching the tab containing the clicked phrase
        const isTamilPhrase = pill.parentElement.id === 'tamil-phrases-list';
        
        if (isTamilPhrase) {
            state.mode = 'ta-en';
            DOM.btnModeTaEn.classList.add('active');
            DOM.btnModeEnTa.classList.remove('active');
            DOM.fallbackInputField.placeholder = "Type text in Tamil to translate to English...";
        } else {
            state.mode = 'en-ta';
            DOM.btnModeEnTa.classList.add('active');
            DOM.btnModeTaEn.classList.remove('active');
            DOM.fallbackInputField.placeholder = "Type text in English to translate to Tamil...";
        }
        
        // If not in a call, notify user and auto-start it for a realistic feel!
        if (state.callStatus !== 'connected') {
            setCallStatus('connected');
        }
        
        processSpeechPipeline(textVal);
    });
});
