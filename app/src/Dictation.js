import React, { Component } from "react";

import {
  fetchToken,
  processAudioData,
  setupWebSocket,
  startAudioRecording,
  stopAudioRecording,
} from "./audioUtils";

const withDictation = (WrappedComponent) => {
  return class extends Component {
    constructor(props) {
      super(props);
      this.state = {
        isRecording: false,
        texts: {}, // Incoming array of strings from server
        message: "", // Aggregated string from texts
      };
    }
    toggleRecording = async () => {
      const { isRecording } = this.state;
      if (isRecording) {
        this.stopRecording();
      } else {
        this.startRecording();
      }
    };

    restartRecording = async () => {
      const { isRecording } = this.state;
      if (isRecording) {
        this.stopRecording();
      }
      this.startRecording();
    };

    startRecording = async () => {
      const token = await fetchToken();

      if (token) {
        setupWebSocket(token, this.onOpen, this.onMessage);
      }

      this.setState({ isRecording: true });
    };

    stopRecording = () => {
      stopAudioRecording();
      this.setState({ isRecording: false, message: "", texts: {} });
    };

    onOpen = () => {
      startAudioRecording(processAudioData);
    };

    onMessage = (message) => {
      const { texts } = this.state;

      let msg = "";
      const res = JSON.parse(message.data);
      texts[res.audio_start] = res.text;
      const keys = Object.keys(texts);
      keys.sort((a, b) => a - b);
      for (const key of keys) {
        if (texts[key]) {
          msg += ` ${texts[key]}`;
        }
      }

      this.setState({ message: msg, texts });
    };

    render() {
      const { isRecording, message } = this.state;
      console.log("rerendering wrapped component with message", message);
      return (
        <WrappedComponent
          currentRecordingMessage={message}
          toggleRecording={this.toggleRecording}
          restartRecording={this.restartRecording}
          startRecording={this.startRecording}
          stopRecording={this.stopRecording}
          isRecording={isRecording}
          {...this.props}
        />
      );
    }
  };
};

export default withDictation;
