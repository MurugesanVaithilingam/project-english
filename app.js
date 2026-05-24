/**
 * Kutty Brw - Tamil-English Call Translator Controller
 * 100% Free, Client-side Speech Recognition, Translation, and Synthesis.
 */

// --- App State Management ---
const state = {
    callStatus: 'idle', // idle, ringing, connected, ended
    sourceLang: 'ta-IN',
    targetLang: 'en-US',
    isMuted: false, // Mutes speech synthesis output
    isListening: false,
    isProcessing: false, // Prevents overlapping mic input/feedback loops
    continuousRecognition: true,
    autoSpeak: true,
    speechRate: 1.0,
    speechPitch: 1.0,
    callDuration: 0,
    timerInterval: null,
    audioContext: null,
    ringOscillators: [],
    ringGainNode: null,
    activeUtterance: null,
    speechBuffer: '',
    speechTimeout: null,
    geminiApiKey: localStorage.getItem('geminiApiKey') || ''
};

// --- DOM Reference Selectors ---
const DOM = {
    appTitle: document.getElementById('app-title'),
    selectSourceLang: document.getElementById('source-lang'),
    selectTargetLang: document.getElementById('target-lang'),
    btnSwapLangs: document.getElementById('btn-swap-langs'),
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
    
    // Status Indicators
    statusEngine: document.getElementById('status-engine'),
    statusEngineDot: document.getElementById('status-engine-dot'),
    statusTts: document.getElementById('status-tts'),
    statusTtsDot: document.getElementById('status-tts-dot'),
    
    // Settings Modal elements
    settingsModal: document.getElementById('settings-modal'),
    btnCloseSettings: document.getElementById('btn-close-settings'),
    btnSaveSettings: document.getElementById('btn-save-settings'),
    selectPlaybackVoice: document.getElementById('select-playback-voice'),
    sliderSpeechRate: document.getElementById('slider-speech-rate'),
    lblSpeechRate: document.getElementById('lbl-speech-rate'),
    sliderSpeechPitch: document.getElementById('slider-speech-pitch'),
    lblSpeechPitch: document.getElementById('lbl-speech-pitch'),
    chkAutoSpeak: document.getElementById('chk-auto-speak'),
    chkContinuousMic: document.getElementById('chk-continuous-mic'),
    micHint: document.getElementById('mic-hint'),
    inputGeminiKey: document.getElementById('input-gemini-key')
};

// Initialize settings fields
if (state.geminiApiKey) DOM.inputGeminiKey.value = state.geminiApiKey;

// --- Web Speech API Availability Checks ---
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognitionInstance = null;

if (!SpeechRecognition) {
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
    DOM.selectPlaybackVoice.innerHTML = '<option value="default">System Default Voice</option>';
    
    const targetLangPrefix = state.targetLang.split('-')[0];
    let defaultIdx = -1;
    
    availableVoices.forEach((voice, index) => {
        if (voice.lang.startsWith(targetLangPrefix)) {
            const option = document.createElement('option');
            option.value = index;
            option.textContent = `${voice.name} (${voice.lang})`;
            DOM.selectPlaybackVoice.appendChild(option);
            
            // Prefer natural/Google voices
            if (defaultIdx === -1 && (voice.name.includes('Google') || voice.name.includes('Natural') || voice.name.includes('Premium'))) {
                defaultIdx = index;
            }
        }
    });

    if (defaultIdx !== -1) {
        DOM.selectPlaybackVoice.value = defaultIdx;
    }
}

if (synth) {
    loadVoices();
    if (speechSynthesis.onvoiceschanged !== undefined) {
        speechSynthesis.onvoiceschanged = loadVoices;
    }
}

// --- Initialize Speech Recognition (one-shot mode — prevents Android cumulative repetition) ---
function initRecognition() {
    if (!SpeechRecognition) return;
    recognitionInstance = new SpeechRecognition();
    recognitionInstance.continuous = false;       // ONE-SHOT: fires once then stops — no cumulative buffer
    recognitionInstance.interimResults = false;   // Final results only — no interim noise on mobile
    recognitionInstance.maxAlternatives = 1;
    recognitionInstance.lang = state.sourceLang;
    bindRecognitionEvents();
}

if (SpeechRecognition) {
    initRecognition();
}

// --- Sound Effects Generator (Web Audio API) ---
function initAudioContext() {
    try {
        if (!state.audioContext) {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (AudioContextClass) {
                state.audioContext = new AudioContextClass();
            }
        }
        if (state.audioContext && state.audioContext.state === 'suspended') {
            state.audioContext.resume();
        }
    } catch (e) {
        console.error("AudioContext initialization failed:", e);
    }
}

// Generates ringing tones (simulated telephone ring)
function startRingtoneSynth() {
    try {
        initAudioContext();
        const ctx = state.audioContext;
        if (!ctx) return;
        
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
    } catch (e) {
        console.error("Ringtone Synthesis error: ", e);
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
        stopListening(true);
        state.isProcessing = false;
    } 
    else if (newStatus === 'ringing') {
        DOM.callOverlay.classList.add('hidden');
        DOM.callRinging.classList.remove('hidden');
        
        // Dynamic flags in ringing UI based on translation mode
        const sourceName = DOM.selectSourceLang.options[DOM.selectSourceLang.selectedIndex].text;
        const targetName = DOM.selectTargetLang.options[DOM.selectTargetLang.selectedIndex].text;
        
        if (state.sourceLang.startsWith('ta')) {
            DOM.ringingFlag.innerText = "🇮🇳";
            DOM.ringingTitle.innerText = `Calling Tamil Line...`;
            DOM.callRinging.querySelector('.avatar-large').className = "avatar-large ringing tamil-ring";
        } else if (state.sourceLang.startsWith('en')) {
            DOM.ringingFlag.innerText = "🇬🇧";
            DOM.ringingTitle.innerText = `Calling English Line...`;
            DOM.callRinging.querySelector('.avatar-large').className = "avatar-large ringing";
        } else {
            DOM.ringingFlag.innerText = "🌐";
            DOM.ringingTitle.innerText = `Connecting ${sourceName} Line...`;
            DOM.callRinging.querySelector('.avatar-large').className = "avatar-large ringing";
        }
        
        DOM.ringingSubtitle.innerText = `Initializing Speech-to-Speech translator (${sourceName} ➔ ${targetName})...`;
        
        startRingtoneSynth();
    } 
    else if (newStatus === 'connected') {
        DOM.callOverlay.classList.add('hidden');
        DOM.callRinging.classList.add('hidden');
        DOM.btnMicTrigger.disabled = false;
        DOM.btnDisconnectCall.disabled = false;
        DOM.btnMicTrigger.classList.add('call-active');
        state.isProcessing = false;
        
        const sourceName = DOM.selectSourceLang.options[DOM.selectSourceLang.selectedIndex].text;
        
        if (state.sourceLang.startsWith('ta')) {
            DOM.btnMicTrigger.classList.remove('english-mic');
            DOM.avatarRing.className = "avatar-ring active tamil";
        } else {
            DOM.btnMicTrigger.classList.add('english-mic');
            DOM.avatarRing.className = "avatar-ring active";
        }
        
        DOM.micHint.innerText = `Tap to speak ${sourceName}`;
        
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
    // Lock the mic processing to prevent overlap
    state.isProcessing = true;

    if (!synth || state.isMuted) {
        state.isProcessing = false;
        if (state.callStatus === 'connected') {
            setTimeout(() => {
                if (state.callStatus === 'connected' && !state.isProcessing) {
                    startListening();
                }
            }, 300);
        }
        return;
    }
    
    // Stop ongoing speech
    synth.cancel();
    
    // STOP the mic from listening to prevent the app from hearing itself (Echo loop)
    if (recognitionInstance) {
        try { recognitionInstance.abort(); } catch(e) {}
    }
    
    const utterance = new SpeechSynthesisUtterance(text);
    state.activeUtterance = utterance;
    
    // Config voice
    utterance.rate = state.speechRate;
    utterance.pitch = state.speechPitch;
    
    // Pick the selected voice based on target language
    if (lang === 'en') {
        if (DOM.selectPlaybackVoice && DOM.selectPlaybackVoice.value !== 'default' && availableVoices[DOM.selectPlaybackVoice.value]) {
            utterance.voice = availableVoices[DOM.selectPlaybackVoice.value];
        }
        utterance.lang = 'en-US';
    } else if (lang === 'ta') {
        if (DOM.selectPlaybackVoice && DOM.selectPlaybackVoice.value !== 'default' && availableVoices[DOM.selectPlaybackVoice.value]) {
            utterance.voice = availableVoices[DOM.selectPlaybackVoice.value];
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
        state.isProcessing = false; // Release lock
        
        // Always restart mic after TTS finishes if call is still connected
        if (state.callStatus === 'connected') {
            state.isListening = true;
            setTimeout(() => {
                if (state.callStatus === 'connected' && !state.isProcessing) {
                    startListening();
                }
            }, 600); // 600ms delay to clear any hardware audio tail/echo on mobile
        }
    };

    utterance.onerror = (e) => {
        console.error("Speech Synthesis Error: ", e);
        DOM.waveContainer.classList.remove('speaking');
        DOM.statusTts.innerText = "Active";
        state.activeUtterance = null;
        state.isProcessing = false; // Release lock
        
        if (state.callStatus === 'connected') {
            setTimeout(() => {
                if (state.callStatus === 'connected' && !state.isProcessing) {
                    startListening();
                }
            }, 300);
        }
    };
    
    synth.speak(utterance);
}

// --- Speech Recognition Triggers ---
function startListening() {
    if (!SpeechRecognition) return;

    // Create a fresh instance every time — this is the KEY fix.
    // Re-using the same instance on mobile Chrome causes it to accumulate
    // all previous sessions' transcripts and repeat them.
    initRecognition();

    // Cancel active TTS output to avoid mic feedback loop
    if (synth && synth.speaking) {
        synth.cancel();
    }

    try {
        recognitionInstance.start();
        state.isListening = true;

        DOM.btnMicTrigger.classList.add('listening');
        setWaveformLabel(`Listening for ${DOM.selectSourceLang.options[DOM.selectSourceLang.selectedIndex].text}...`);
        DOM.waveContainer.classList.add('speaking');
        DOM.statusEngine.innerText = "Listening";
        DOM.statusEngineDot.className = "status-dot yellow";
    } catch (e) {
        console.log("Speech recognition start issue: ", e);
    }
}

function stopListening(force = false) {
    if (recognitionInstance) {
        try { recognitionInstance.abort(); } catch(e) {}
    }

    if (force) {
        state.isListening = false;
        clearTimeout(state.speechTimeout);
        DOM.btnMicTrigger.classList.remove('listening');
        DOM.waveContainer.classList.remove('speaking');
        setWaveformLabel("Mic Off");
        DOM.statusEngine.innerText = "Ready";
        DOM.statusEngineDot.className = "status-dot green";
    }
}

// Bind all events onto the current recognitionInstance (called inside initRecognition)
function bindRecognitionEvents() {
    if (!recognitionInstance) return;

    // ONE-SHOT: because continuous=false, each session fires onresult ONCE
    // with ONLY what the user said this session. No past speech, no repetition.
    recognitionInstance.onresult = (event) => {
        // event.results[0] is the single result from this one-shot session
        const transcript = event.results[0][0].transcript.trim();
        if (!transcript) return;

        setWaveformLabel("Heard: " + transcript);

        // Lock & process immediately — no timeout needed in one-shot mode
        state.isProcessing = true;
        processSpeechPipeline(transcript);
    };

    recognitionInstance.onerror = (event) => {
        console.warn("Speech Recognition error: ", event.error);

        if (event.error === 'not-allowed') {
            setWaveformLabel("Microphone Permission Denied. Please allow mic access.");
            DOM.statusEngine.innerText = "Blocked";
            DOM.statusEngineDot.className = "status-dot red";
            state.isListening = false;
            DOM.btnMicTrigger.classList.remove('listening');
            DOM.waveContainer.classList.remove('speaking');
            return;
        }

        // no-speech or aborted: just restart cleanly if still in call
        const isSpeaking = synth && synth.speaking;
        if (state.callStatus === 'connected' && !isSpeaking && !state.activeUtterance && !state.isProcessing) {
            setTimeout(() => {
                if (state.callStatus === 'connected' && !state.activeUtterance && !state.isProcessing) {
                    startListening();
                }
            }, 300);
        }
    };

    // onend fires after each one-shot result. If not processing/speaking, restart.
    recognitionInstance.onend = () => {
        DOM.btnMicTrigger.classList.remove('listening');
        DOM.waveContainer.classList.remove('speaking');

        const isSpeaking = synth && synth.speaking;
        if (state.callStatus === 'connected' && !isSpeaking && !state.activeUtterance && !state.isProcessing) {
            setTimeout(() => {
                if (state.callStatus === 'connected' && !state.activeUtterance && !state.isProcessing) {
                    startListening();
                }
            }, 400);
        }
    };
}

// --- Grammar Check API (LanguageTool) ---
const LT_SUPPORTED_LANGUAGES = {
    'en-US': 'en-US',
    'en-GB': 'en-GB',
    'de-DE': 'de-DE',
    'es-ES': 'es',
    'fr-FR': 'fr',
    'ja-JP': 'ja',
    'zh-CN': 'zh-CN',
    'ru-RU': 'ru',
    'pt-BR': 'pt-BR',
    'ar-SA': 'ar',
    'hi-IN': 'hi',
    'ta-IN': 'ta',
    'ml-IN': 'ml', // Attempt Malayalam if supported
    'te-IN': 'te', // Attempt Telugu if supported
    'kn-IN': 'kn'  // Attempt Kannada if supported
};

async function checkGrammar(text, langCode) {
    const ltLang = LT_SUPPORTED_LANGUAGES[langCode];
    if (!ltLang) {
        // Skip grammar check silently if not supported by LanguageTool
        return { hasMistake: false, correctedText: text, originalText: text };
    }
    
    try {
        const response = await fetch('https://api.languagetool.org/v2/check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `text=${encodeURIComponent(text)}&language=${ltLang}`
        });
        const data = await response.json();
        
        if (data.matches && data.matches.length > 0) {
            let corrected = text;
            let offsetAdjust = 0;
            
            data.matches.forEach(match => {
                if (match.replacements && match.replacements.length > 0) {
                    const replacement = match.replacements[0].value;
                    const start = match.offset + offsetAdjust;
                    const end = start + match.length;
                    
                    corrected = corrected.substring(0, start) + replacement + corrected.substring(end);
                    offsetAdjust += (replacement.length - match.length);
                }
            });
            return { hasMistake: true, correctedText: corrected, originalText: text };
        }
    } catch (e) {
        console.error("Grammar check error: ", e);
    }
    return { hasMistake: false, correctedText: text, originalText: text };
}

// --- Main Text/Speech Processing Pipeline ---
async function processSpeechPipeline(textInput) {
    const fromLang = state.sourceLang.split('-')[0];
    const toLang = state.targetLang.split('-')[0];
    const sourceNodeClass = 'self';
    
    try {
        // Check Grammar first
        setWaveformLabel("Checking grammar...");
        const grammarResult = await checkGrammar(textInput, state.sourceLang);
        const finalSourceText = grammarResult.hasMistake ? grammarResult.correctedText : textInput;
        
        // Update visualizer state to translating
        setWaveformLabel("Translating...");
        DOM.statusEngine.innerText = "Translating";
        
        // Run translation API (Free)
        const translatedResult = await fetchTranslation(finalSourceText, fromLang, toLang);
        
        // Output dialogue node HTML
        await appendDialogueBubble(grammarResult, translatedResult, sourceNodeClass);
        
        DOM.statusEngine.innerText = "Ready";
        if (state.isListening) {
            DOM.statusEngineDot.className = "status-dot yellow";
        }
        
        // Run Voice Output (Speech Synthesis)
        if (state.autoSpeak) {
            speakTranslation(translatedResult, toLang);
        } else {
            state.isProcessing = false; // Release lock
            setWaveformLabel("Call connected. Press Microphone to talk!");
            if (state.callStatus === 'connected') {
                startListening();
            }
        }
    } catch (error) {
        console.error("Speech pipeline error: ", error);
        state.isProcessing = false; // Release lock
        setWaveformLabel("Error occurred. Ready.");
        if (state.callStatus === 'connected') {
            startListening();
        }
    }
}

// Render dynamic dialog bubbles in the UI
async function appendDialogueBubble(grammarResult, translatedText, senderClass) {
    // Hide empty transcript state
    DOM.conversationEmptyState.classList.add('hidden');
    
    const node = document.createElement('article');
    node.className = `dialogue-node ${senderClass}`;
    
    // Get language names for UI display
    const sourceSelect = DOM.selectSourceLang.options[DOM.selectSourceLang.selectedIndex];
    const targetSelect = DOM.selectTargetLang.options[DOM.selectTargetLang.selectedIndex];
    
    const targetLangTag = targetSelect.text;
    const sourceLangTag = sourceSelect.text;
    
    // Get timestamp
    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    
    let originalTextHtml = `Original (${sourceLangTag}): <span>${grammarResult.originalText}</span>`;
    if (grammarResult.hasMistake) {
        originalTextHtml = `
            <div class="grammar-original-container">
                <span class="grammar-badge-red">Original</span>
                <del>${grammarResult.originalText}</del>
            </div>
            <div class="grammar-corrected-container">
                <span class="grammar-badge-green">Corrected</span>
                <span>${grammarResult.correctedText}</span>
            </div>
        `;
    }
    
    // Suggested Answers logic (client-side intent matching or Gemini API)
    const suggestionData = await generateSuggestedReplies(translatedText);
    const suggestions = suggestionData.replies || [];
    const isAi = suggestionData.isAi || false;
    
    let suggestionsHtml = '';
    
    if (suggestions.length > 0) {
        suggestionsHtml = `
            <div class="suggested-replies-container">
                ${suggestions.map(reply => `<button class="reply-chip ${isAi ? 'ai-chip' : ''}">${reply}</button>`).join('')}
            </div>
        `;
    }
    
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
            ${suggestionsHtml}
            <div class="translated-divider"></div>
            <div class="source-text">${originalTextHtml}</div>
        </div>
    `;
    
    // Listen to play speaker button
    node.querySelector('.btn-speak-text').addEventListener('click', (e) => {
        e.stopPropagation();
        playAudioCue('click');
        const targetLang = state.targetLang.split('-')[0];
        speakTranslation(translatedText, targetLang);
    });

    // Listen to reply chips
    const chips = node.querySelectorAll('.reply-chip');
    chips.forEach(chip => {
        chip.addEventListener('click', (e) => {
            e.stopPropagation();
            playAudioCue('click');
            // If user clicked a reply, we set it as if they spoke it in their source lang
            // The replies are generated in English, so we treat it as textInput
            // Actually, we must process it directly
            state.isProcessing = true;
            processSpeechPipeline(chip.innerText);
        });
    });
    
    DOM.transcriptContainer.appendChild(node);
    
    // Smooth scroll to bottom
    DOM.transcriptContainer.scrollTop = DOM.transcriptContainer.scrollHeight;
}

function setWaveformLabel(text) {
    DOM.waveformLabel.innerText = text;
}

// --- Quick Call Assist Phrases Data ---
const QUICK_PHRASES = {
    'ta-IN': [
        { text: 'வணக்கம், நலம் தானா?', label: 'Hello' },
        { text: 'தயவுசெய்து மெதுவாகப் பேசுங்கள்.', label: 'Speak Slowly' },
        { text: 'நான் ஒரு குரல் மொழிபெயர்ப்பாளரைப் பயன்படுத்துகிறேன்.', label: 'Using Translator' },
        { text: 'ஒரு நிமிடம் காத்திருங்கள்.', label: 'Wait a moment' },
        { text: 'நன்றி.', label: 'Thank you' }
    ],
    'en-US': [
        { text: 'Hello, how are you?', label: 'Hello' },
        { text: 'Please speak a bit slowly.', label: 'Speak Slowly' },
        { text: 'I am using a real-time voice translator.', label: 'Using Translator' },
        { text: 'Please wait for a moment.', label: 'Wait a moment' },
        { text: 'Thank you very much.', label: 'Thank you' }
    ],
    'es-ES': [
        { text: 'Hola, ¿cómo estás?', label: 'Hello' },
        { text: 'Por favor, habla más despacio.', label: 'Speak Slowly' },
        { text: 'Estoy usando un traductor de voz.', label: 'Using Translator' },
        { text: 'Un momento, por favor.', label: 'Wait a moment' },
        { text: 'Muchas gracias.', label: 'Thank you' }
    ],
    'fr-FR': [
        { text: 'Bonjour, comment allez-vous ?', label: 'Hello' },
        { text: 'Parlez plus lentement, s’il vous plaît.', label: 'Speak Slowly' },
        { text: 'J’utilise un traducteur vocal.', label: 'Using Translator' },
        { text: 'Un instant, s’il vous plaît.', label: 'Wait a moment' },
        { text: 'Merci beaucoup.', label: 'Thank you' }
    ],
    'de-DE': [
        { text: 'Hallo, wie geht es dir?', label: 'Hello' },
        { text: 'Sprechen Sie bitte etwas langsamer.', label: 'Speak Slowly' },
        { text: 'Ich verwende einen Sprachübersetzer.', label: 'Using Translator' },
        { text: 'Einen Moment, bitte.', label: 'Wait a moment' },
        { text: 'Vielen Dank.', label: 'Thank you' }
    ],
    'hi-IN': [
        { text: 'नमस्ते, आप कैसे हैं?', label: 'Hello' },
        { text: 'कृपया थोड़ा धीरे बोलें।', label: 'Speak Slowly' },
        { text: 'मैं एक वॉयस ट्रांसलेटर का उपयोग कर रहा हूँ।', label: 'Using Translator' },
        { text: 'कृपया एक क्षण प्रतीक्षा करें।', label: 'Wait a moment' },
        { text: 'बहुत-बहुत धन्यवाद।', label: 'Thank you' }
    ]
};

function loadQuickPhrases() {
    const container = document.getElementById('quick-phrases-container');
    if (!container) return;
    
    container.innerHTML = '';
    
    // Add layout class to color badges based on language direction
    if (state.sourceLang.startsWith('ta')) {
        container.classList.add('tamil-active-qp');
    } else {
        container.classList.remove('tamil-active-qp');
    }
    
    // Get phrases for current source language, fallback to English
    const phrases = QUICK_PHRASES[state.sourceLang] || QUICK_PHRASES['en-US'];
    
    phrases.forEach(phrase => {
        const btn = document.createElement('button');
        btn.className = 'quick-phrase-btn';
        btn.title = phrase.text;
        btn.innerHTML = `
            <span class="qp-label">${phrase.label}</span>
            <span class="qp-text">${phrase.text}</span>
        `;
        btn.addEventListener('click', () => {
            if (state.callStatus !== 'connected') {
                alert("Please start the call first to use Assist Phrases.");
                return;
            }
            playAudioCue('click');
            
            // Set lock and abort active mic to avoid capturing clicks/echo
            state.isProcessing = true;
            if (recognitionInstance) {
                try { recognitionInstance.abort(); } catch(e) {}
            }
            
            processSpeechPipeline(phrase.text);
        });
        container.appendChild(btn);
    });
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

// Microphone button — during a call it restarts mic (never disconnects loop)
DOM.btnMicTrigger.addEventListener('click', () => {
    playAudioCue('click');
    
    if (!recognitionInstance) {
        alert("Speech Recognition is not supported in this browser. Please use the Text Input Fallback.");
        return;
    }
    
    // During an active call: just restart mic (never kill the loop)
    if (state.callStatus === 'connected') {
        if (synth && synth.speaking) synth.cancel(); // stop TTS if speaking
        state.isProcessing = false; // Reset lock if they force-clicked the mic button!
        try { recognitionInstance.stop(); } catch(e) {}
        setTimeout(() => startListening(), 200);
        return;
    }
    
    // Outside a call: normal toggle
    if (state.isListening) {
        stopListening(true);
    } else {
        startListening();
    }
});

// Language selectors & Swap button
DOM.selectSourceLang.addEventListener('change', (e) => {
    state.sourceLang = e.target.value;
    const langLabel = DOM.selectSourceLang.options[DOM.selectSourceLang.selectedIndex].text;
    DOM.fallbackInputField.placeholder = `Type text in ${langLabel} to translate...`;
    
    // Refresh Quick Phrases
    loadQuickPhrases();
    
    if (state.callStatus === 'connected') {
        const sourceLabel = DOM.selectSourceLang.options[DOM.selectSourceLang.selectedIndex].text;
        DOM.micHint.innerText = `Tap to speak ${sourceLabel}`;
        
        if (state.sourceLang.startsWith('ta')) {
            DOM.btnMicTrigger.classList.remove('english-mic');
            DOM.avatarRing.className = "avatar-ring active tamil";
        } else {
            DOM.btnMicTrigger.classList.add('english-mic');
            DOM.avatarRing.className = "avatar-ring active";
        }
        
        if (state.isListening) {
            stopListening();
            startListening();
        }
    }
});

DOM.selectTargetLang.addEventListener('change', (e) => {
    state.targetLang = e.target.value;
    loadVoices();
});

DOM.btnSwapLangs.addEventListener('click', () => {
    playAudioCue('click');
    const temp = state.sourceLang;
    state.sourceLang = state.targetLang;
    state.targetLang = temp;
    
    DOM.selectSourceLang.value = state.sourceLang;
    DOM.selectTargetLang.value = state.targetLang;
    
    const langLabel = DOM.selectSourceLang.options[DOM.selectSourceLang.selectedIndex].text;
    DOM.fallbackInputField.placeholder = `Type text in ${langLabel} to translate...`;
    
    // Refresh Quick Phrases
    loadQuickPhrases();
    
    loadVoices();
    
    if (state.callStatus === 'connected') {
        const sourceLabel = DOM.selectSourceLang.options[DOM.selectSourceLang.selectedIndex].text;
        DOM.micHint.innerText = `Tap to speak ${sourceLabel}`;
        
        if (state.sourceLang.startsWith('ta')) {
            DOM.btnMicTrigger.classList.remove('english-mic');
            DOM.avatarRing.className = "avatar-ring active tamil";
        } else {
            DOM.btnMicTrigger.classList.add('english-mic');
            DOM.avatarRing.className = "avatar-ring active";
        }
        
        if (state.isListening) {
            stopListening();
            startListening();
        }
    }
});

// Auto-start audio context on first interaction
document.body.addEventListener('click', () => {
    if (!state.audioContext) {
        initAudioContext();
    }
}, { once: true });

// --- Suggested Replies Engine ---
async function generateSuggestedReplies(text) {
    // If Gemini API Key exists, use it for dynamic smart replies
    if (state.geminiApiKey) {
        try {
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${state.geminiApiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{
                        parts: [{ text: `The other person in a phone call just said: "${text}". Generate 3 very short, natural, conversational reply options in English. Return ONLY a valid JSON array of 3 strings. Example: ["Hello!", "How are you?", "Good morning."]` }]
                    }],
                    generationConfig: { temperature: 0.7, topK: 40, topP: 0.95 }
                })
            });
            const data = await response.json();
            if (data.candidates && data.candidates.length > 0) {
                let aiText = data.candidates[0].content.parts[0].text.trim();
                // Strip markdown formatting if any
                aiText = aiText.replace(/```json/g, '').replace(/```/g, '').trim();
                const replies = JSON.parse(aiText);
                if (Array.isArray(replies) && replies.length > 0) {
                    return { replies: replies.slice(0, 3), isAi: true };
                }
            }
        } catch (e) {
            console.error("Gemini API suggestion error: ", e);
            // Fallback to basic intents below if API fails
        }
    }

    const lowerText = text.toLowerCase();
    let suggestions = [];

    // Simple Intent Matching (Fallback)
    if (lowerText.match(/\b(hi|hello|hey|greetings|how are you|how do you do)\b/)) {
        suggestions = ["Hello! I'm doing well.", "Hi, how can I help?", "I'm good, thank you!"];
    } else if (lowerText.match(/\b(thank you|thanks|appreciate it)\b/)) {
        suggestions = ["You're welcome!", "No problem at all.", "Glad I could help."];
    } else if (lowerText.match(/\b(bye|goodbye|see you|catch you later)\b/)) {
        suggestions = ["Goodbye! Have a great day.", "See you later!", "Take care."];
    } else if (lowerText.match(/\b(yes|no|maybe|are you sure)\b/)) {
        suggestions = ["Yes, absolutely.", "No, not right now.", "Let me check."];
    } else if (lowerText.match(/\b(help|support|assistance)\b/)) {
        suggestions = ["How can I assist you?", "Please tell me more.", "I'm here to help."];
    } else if (lowerText.match(/\b(name|who are you)\b/)) {
        suggestions = ["I'm calling via Kutty Brw.", "My name is on the screen.", "I'm your contact."];
    }

    return { replies: suggestions, isAi: false };
}

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
    
    // Save Gemini API Key
    const key = DOM.inputGeminiKey.value.trim();
    state.geminiApiKey = key;
    if (key) {
        localStorage.setItem('geminiApiKey', key);
    } else {
        localStorage.removeItem('geminiApiKey');
    }
    
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
    
    state.isProcessing = true; // Lock mic
    if (recognitionInstance) {
        try { recognitionInstance.abort(); } catch(e) {}
    }
    processSpeechPipeline(textVal);
});

// Initialize Call Assist Phrases on load
loadQuickPhrases();
