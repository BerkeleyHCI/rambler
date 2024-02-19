import RecordRTC, { StereoAudioRecorder } from "recordrtc";

const ASSEMBLY_AI_ENDPOINT = "wss://api.assemblyai.com/v2/realtime/ws?sample_rate=16000";

let socket = null;
let recorder = null;
let socketShouldBeOpen = false;
const INITIAL_SOCKET_RETRY_DELAY = 50;
let socketRetryDelay = INITIAL_SOCKET_RETRY_DELAY;
const MAX_SOCKET_RETRY_DELAY = 5000;
const getRetryDelay = () => {
  socketRetryDelay = Math.min(socketRetryDelay * 2, MAX_SOCKET_RETRY_DELAY);
  return socketRetryDelay;
};

export const fetchToken = async () => {
  try {
    const response = await fetch("/assembly-user-token");
    const data = await response.json();

    if (data.error) {
      console.error(data.error);
      return null;
    }

    return data.token;
  } catch (error) {
    console.error(error);
    return null;
  }
};

export const setupWebSocket = (token, onOpen, onMessage) => {
  socketShouldBeOpen = true;
  socket = new WebSocket(`${ASSEMBLY_AI_ENDPOINT}&token=${token}`);

  socket.onopen = onOpen;
  socket.onmessage = onMessage;

  socket.onerror = (event) => {
    console.error(event);
    socket.close();
  };

  socket.onclose = (event) => {
    console.log(event);
    socket = null;
    if (socketShouldBeOpen) {
      // If the socket was closed unexpectedly, try to reconnect
      setTimeout(() => {
        fetchToken().then((token) => {
          console.log("Reconnecting to AssemblyAI");
          setupWebSocket(token, onOpen, onMessage);
        });
      }, getRetryDelay());
    }
  };
};

export const startAudioRecording = (onDataAvailable) => {
  if (!recorder) {
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        recorder = new RecordRTC(stream, {
          type: "audio",
          mimeType: "audio/webm;codecs=pcm",
          recorderType: StereoAudioRecorder,
          timeSlice: 250,
          desiredSampRate: 16000,
          numberOfAudioChannels: 1,
          bufferSize: 4096,
          audioBitsPerSecond: 128000,
          ondataavailable: onDataAvailable,
        });

        recorder.startRecording();
      })
      .catch((err) => console.error(err));
  } else {
    // If a recording has been paused, resume it
    recorder.resumeRecording();
  }
};

export const stopAudioRecording = () => {
  socketShouldBeOpen = false;
  socketRetryDelay = INITIAL_SOCKET_RETRY_DELAY;
  if (socket) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ terminate_session: true }));
    }
    socket.close();
  }

  if (recorder) {
    recorder.pauseRecording();
  }
};

export const processAudioData = (blob) => {
  const reader = new FileReader();
  reader.onload = () => {
    const base64data = reader.result;
    if (socket && socket.readyState === 1) {
      // Check that socket is open
      socket.send(
        JSON.stringify({
          audio_data: base64data.split("base64,")[1],
        })
      );
    }
  };
  reader.readAsDataURL(blob);
};
