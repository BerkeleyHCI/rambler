import React, { Component, Fragment } from "react";
import { v4 as uuidv4 } from "uuid";
import io from "socket.io-client";
import { DragDropContext, Droppable } from "react-beautiful-dnd";
import rake from "rake-js";
import debounce from "lodash/debounce";

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Slider from "@mui/material/Slider";
import Snackbar from "@mui/material/Snackbar";
import Modal from "@mui/material/Modal";
import Radio from "@mui/material/Radio";
import RadioGroup from "@mui/material/RadioGroup";
import FormControlLabel from "@mui/material/FormControlLabel";
import FormControl from "@mui/material/FormControl";
import FormLabel from "@mui/material/FormLabel";
import Alert from "@mui/material/Alert";
import TextField from "@mui/material/TextField";
import IconButton from "@mui/material/IconButton";
import {
  Add,
  Settings,
  Cancel,
  CallMerge,
  AutoFixHigh,
} from "@mui/icons-material";
import Checkbox from "@mui/material/Checkbox";

import RambleBox from "./RambleBox";
import withDictation from "./Dictation";
import TextEditorExample from "./TextEditorStudyExample";
import IDExample from "./iterativeDraftingExample";
import llmapi from "./llmapi";
import historyapi from "./historyapi";
import stopWordSet from "./stopWords";
import { downloadContent } from "./utils";

class RambleEditor extends Component {
  constructor(props) {
    // props should contain fileId, plus get/setRambles functions, and get/setTitle functions.
    super(props);
    this.defaultState = {
      title: "New Topic",
      rambleBoxes: [],
      currentMessageSummary: "",
      UIVersion: "C", // A=speech/keyboard only, B=noLLM, C=LLM
      activeRambleBox: -1,
      editingRambleBox: -1,
      respeakingRambleBox: -1,
      areBlockToolsEnabled: true, // controls if we have ramble boxes
      areLLMToolsEnabled: true, // controls if LLM tools are enabled
      isSettingsModalOpen: false,
      isCustomPromptModalOpen: false,
      viewLevel: 1, // 0 = full text, 1 = cleaned, 4 = shortest summary
      snackOpen: false,
      snackText: "",
      severity: "info",
      LLMcommandTargetId: -1,
      mergingBoxIds: new Set(),
      autoMergeBoxIds: new Set(),
      customPrompt: "",
      cursorPosition: -1, // for when the UI:A textarea is unfocused
      mostRecentLLMUpdate: new Map(), // Map of boxId + level to timestamp
      useKeywordsWithCustomPrompt: false,
      llmOrManualMod: new Map(), // set of ramblebox ids -> timestamp that were just created by merge (auto or manual) or split (auto or manual)
      lastClean: new Map(), // set of ramblebox ids -> last clean 1
    };
    historyapi.context = { UIVersion: this.defaultState.UIVersion };

    this.state = this.defaultState;
    this.baseMessage = `Speak to enter text here!`;

    this.fastSummaryPipeline = llmapi.pipeline(llmapi.fastSummaryAtLevel, (summary) =>
      this.setState({ currentMessageSummary: summary })
    );
  }

  componentDidMount() {
    console.log("Ramble Editor Mounted", this.props);
    // Start fresh (but save localStorage)
    this.clearData({ clearLocal: false });

    // Load in the saved version of the UI
    let UIVersion = localStorage.getItem("UIVersion");
    if (UIVersion === null || UIVersion === "undefined") UIVersion = "C"; // Default, enable LLM/Block tools
    this.updateUIVersion({ target: { value: UIVersion } });

    // See if we have a saved state/title
    const rambleBoxes = this.props.getRambles();
    console.log("Ramble Boxes", rambleBoxes);
    if (rambleBoxes) this.setState({ rambleBoxes });
    const savedTitle = this.props.getTitle();
    if (savedTitle) {
      this.setState({ title: savedTitle });
      document.title = savedTitle;
    } else {
      document.title = this.defaultState.title;
    }

    // Check if localStorage sessionId exists, if not, generate a new one
    let sessionId = this.props.fileId;
    this.setState({ sessionId });

    let SOCKET_PORT;
    if (process.env.NODE_ENV === "production") {
      SOCKET_PORT = process.env.CLIENT_ORIGIN;
      console.log(SOCKET_PORT, "In Production");
    } else {
      SOCKET_PORT = "http://localhost:8200";
      console.log("Development");
    }

    const socket = io(SOCKET_PORT);

    socket.on("chatgptResChunk", (data) => {
      const { rambleBoxId, content, level, timeRequested, replace } = data;
      if (
        this.state.mostRecentLLMUpdate.get(rambleBoxId) &&
        this.state.mostRecentLLMUpdate.get(rambleBoxId)[level] > timeRequested
      ) {
        console.log(this.state.mostRecentLLMUpdate.get(rambleBoxId), timeRequested);
        console.log("Ignoring old response");
        return;
      }
      this.setState((prevState) => ({
        mostRecentLLMUpdate: prevState.mostRecentLLMUpdate.set(rambleBoxId, {
          ...prevState.mostRecentLLMUpdate.get(rambleBoxId),
          [level]: timeRequested,
        }),
        rambleBoxes: prevState.rambleBoxes.map(
          replace
            ? this.updateBox({
                id: rambleBoxId,
                content,
                level,
              })
            : this.updateBox({
                id: rambleBoxId,
                content: (prevState.lastClean.get(rambleBoxId) ?? "") + " " + content,
                level,
              })
        ),
      }));
    });
  }

  componentDidUpdate(prevProps, prevState) {
    if (prevProps.fileId !== this.props.fileId) {
      // file changed; clear.
      console.log("File changed; clearing data.");
      this.clearData({ clearLocal: false });
      this.setState((state) => ({
        sessionId: this.props.fileId,
        title: this.props.getTitle(),
        rambleBoxes: this.props.getRambles(),
      }));
      return;
    }
    this.saveLocalState(); // Save the title/boxes to local storage

    // The current recording message has changed
    const { currentRecordingMessage } = this.props;
    if (prevProps.currentRecordingMessage !== currentRecordingMessage) {
      // No message yet; ignore for now
      if (!currentRecordingMessage) return;
      console.log("Current Recording Message:", currentRecordingMessage);

      // If we're still at the base message, clear it for now
      let { rambleBoxes, activeRambleBox } = this.state;
      const activeIndex = rambleBoxes.findIndex((r) => r.id === activeRambleBox);

      // No active ramble box (shouldn't happen, deleted before this point)
      if (activeIndex === -1) return;

      // logic for UI:A direct transcription
      if (this.state.UIVersion === "A") {
        this.streamWordsCursor(currentRecordingMessage, prevProps.currentRecordingMessage);
      }

      const currentText = rambleBoxes[activeIndex][0];
      if (currentText === this.baseMessage) {
        rambleBoxes[activeIndex][0] = "";
        this.setState({ rambleBoxes });
      }
      historyapi.save("dictation", "live-dictation-update", {
        boxId: activeRambleBox,
        content: currentRecordingMessage,
        level: this.state.level,
      });
    }
  }

  streamWordsCursor = (newWords, oldWords) => {
    const { cursorPosition } = this.state;
    let textarea = document.getElementById("uia-textfield");
    if (textarea) {
      let text = textarea.value;
      text =
        text.slice(0, cursorPosition) + newWords + text.slice(cursorPosition + oldWords.length);
      textarea.value = text;
      textarea.focus();
      textarea.setSelectionRange(cursorPosition, cursorPosition + newWords.length);
    }
  };

  updateBox =
    ({ id, content, level, keywords = null }) =>
    (box) => {
      if (box.id === id) {
        const newRambleBox = Object.assign({}, box);
        if (content === undefined || content === null) return newRambleBox;
        if (
          content.length > 2 &&
          content.charAt(0) === '"' &&
          content.charAt(content.length - 1) === '"'
        ) {
          newRambleBox[level] = content.slice(1, -1);
        } else {
          newRambleBox[level] = content;
        }
        if (keywords) newRambleBox.keywords = keywords;
        return newRambleBox;
      } else {
        return box;
      }
    };

  updateBoxKeywords = (rambleBoxId, keywords) => (box) => {
    const { areLLMToolsEnabled } = this.state;
    if (!areLLMToolsEnabled) return box;
    if (box.id === rambleBoxId) {
      const newRambleBox = Object.assign({}, box);
      const currentText = newRambleBox[1] ?? "";
      const currentWords = currentText ? currentText.split(" ").filter((s) => s.length > 0) : [];
      newRambleBox.keywords = Array.from(new Set([...newRambleBox.keywords, ...keywords]));
      // remove keywords no longer in text
      newRambleBox.keywords = newRambleBox.keywords.filter((keyword) =>
        currentWords.includes(keyword)
      );

      return newRambleBox;
    } else {
      return box;
    }
  };

  getRakeKeywordsFromText = (text) => {
    let keywords = rake(text, { language: "english" });
    const wordCount = text.split(" ").filter((s) => s.length > 0).length;
    let keywordCount = Math.floor(Math.log(wordCount)) + 1;

    keywords = keywords.length > keywordCount ? keywords.slice(0, keywordCount) : keywords;
    const individualKeywords = [];
    for (const keyword of keywords) {
      const keywordComponents = keyword.split(" ");
      individualKeywords.push(...keywordComponents);
    }

    const keywordsSet = new Set(individualKeywords);
    return Array.from(keywordsSet);
  };

  setRakeKeywords = (id) => {
    const { rambleBoxes } = this.state;
    const initialBox = rambleBoxes.find((box) => box.id === id);
    if (!initialBox) {
      this.handleSnackText(`No box found with id: ${id}`, "error");
      return;
    }
    const text = initialBox[1];

    this.setState((prevState) => ({
      rambleBoxes: prevState.rambleBoxes.map(
        this.updateBoxKeywords(id, this.getRakeKeywordsFromText(text))
      ),
    }));
  };

  generateRakeKeywords = () => {
    this.setState((prevState) => ({
      rambleBoxes: prevState.rambleBoxes.map((box) => {
        const keywords = this.getRakeKeywordsFromText(box[0]);
        return { ...box, keywords };
      }),
    }));
  };

  clearKeywords = () => {
    this.setState((prevState) => ({
      rambleBoxes: prevState.rambleBoxes.map((box) => {
        return { ...box, keywords: [] };
      }),
    }));
  };

  confirmClearData = () => {
    // A better version of this would be to reuse the internal modal. Simple for now though.
    if (window.confirm(`Are you sure you want to clear all data?`)) {
      this.clearData();
    }
  };

  clearData = (opts = { clearLocal: true }) => {
    // Retain UIVersion state when clearing data.
    const { UIVersion } = this.state;
    let uiVersionAStatePatch = {};
    if (UIVersion === "A") {
      uiVersionAStatePatch = {
        areBlockToolsEnabled: false,
        areLLMToolsEnabled: false,
        UIVersion: "A",
      };
    }
    this.setState({ ...this.defaultState, ...uiVersionAStatePatch });
    document.title = this.defaultState.title;

    if (opts.clearLocal) {
      localStorage.setItem("rambleBoxes", "");
      localStorage.setItem("rambleTitle", "");
      this.handleSnackText("Data cleared.", "info");
    }
  };

  // regenerateSessionId = () => {
  //   const newId = resetSessionId();
  //   localStorage.setItem("sessionId", newId);
  //   this.setState({ sessionId: newId });
  //   this.handleSnackText("Regenerated session ID.", "info");
  // };

  saveLocalState = () => {
    // If this gets too big, omit the summaries.
    const { title, rambleBoxes } = this.state;
    if (title !== this.props.getTitle()) {
      this.props.setTitle(title);
    }
    if (
      rambleBoxes !== this.props.getRambles() ||
      rambleBoxes.some((box, i) =>
        Object.keys(box).some((j) => box[j] !== this.props.getRambles()[i][j])
      )
    ) {
      this.props.setRambles(rambleBoxes);
    }
  };

  copyRambleBoxes = () => {
    let { rambleBoxes, viewLevel, UIVersion } = this.state;
    if (UIVersion === "A") rambleBoxes = [rambleBoxes[0]]; // Only copy the first box
    let text = rambleBoxes.map((box) => box[viewLevel]).join("\n\n");

    // Remove leading spaces from each line
    text = text.replace(/^ +/gm, "");
    navigator.clipboard.writeText(text);
    this.handleSnackText(`Copied all text to clipboard.`, "success");
    historyapi.save("editing", "copy-boxes", {
      viewLevel,
      text,
    });
  };

  exportTXT = () => {
    const { title, rambleBoxes, viewLevel } = this.state;
    let content = rambleBoxes.map((box) => box[viewLevel]).join("\n\n");
    // Remove leading spaces from each line
    content = content.replace(/^ +/gm, "");
    console.log("Exporting:\n\n" + content);

    // Download ramble box text (like copy) but as txt file
    const filename = `${title}-${Date.now()}.txt`;
    downloadContent({ filename, content });

    this.handleSnackText(`Exported ${filename}.`, "success");
    historyapi.save("editing", "download-txt-boxes", {
      viewLevel,
      text: content,
    });
  };

  exportJSON = () => {
    // Form state object
    const { title, rambleBoxes } = this.state;
    const stateJSON = { title, rambleBoxes };
    console.log(stateJSON);

    // Download state as JSON file
    const content = JSON.stringify(stateJSON);
    const filename = `${title}-${Date.now()}.json`;
    downloadContent({
      filename,
      content,
    });

    this.handleSnackText(`Exported ${filename}.`, "success");
    historyapi.save("editing", "download-json-boxes", {
      text: content,
    });
  };

  importJSON = () => {
    const fileInput = document.getElementById("files");
    if (fileInput) fileInput.click();
  };

  handleFileSelect = (evt) => {
    const [file] = evt.target.files;
    if (!file || !file.name) return;
    if (file.type.match("/json$")) {
      this.handleStateLoad(file); // Load State
    } else {
      console.error(`Load JSON files only.`);
    }
  };

  handleStateLoad = (file) => {
    this.clearData();
    let reader = new FileReader();
    reader.readAsText(file);
    reader.onload = () => {
      try {
        let json_object = JSON.parse(reader.result);
        console.log(`Loading Example: ${file.name}`);
        this.setState(json_object);
        this.handleSnackText("Successfully loaded JSON.", "success");
      } catch (e) {
        console.error(e);
      }
    };
  };

  loadExample = () => {
    const title = "Practicing Art through a Sketchbook";
    this.clearData();
    this.handleSnackText("Loaded example data.", "success");
    document.title = title;
    this.setState(
      {
        title,
        rambleBoxes: IDExample,
      },
      this.generateRakeKeywords
    );
  };

  loadExampleForStudy = () => {
    const { UIVersion } = this.state;
    if (UIVersion === "A") {
      const title = "Practicing Drawing from Photos vs Real Life";
      this.clearData();
      this.handleSnackText("Loaded A - Text Editor / ChatGPT Study Example.", "success");
      document.title = title;
      this.setState(
        {
          title,
          rambleBoxes: TextEditorExample,
        },
        this.generateRakeKeywords
      );
    } else if (UIVersion === "C") {
      const title = "Practicing Art through a Sketchbook";
      this.clearData();
      this.handleSnackText("Loaded C - LLM-Assisted Iterative Drafting Study Example.", "success");
      document.title = title;
      this.setState(
        {
          title,
          rambleBoxes: IDExample,
        },
        this.generateRakeKeywords
      );
    }
  };

  makeNewRambleBox = (baseMessage = "", level = 0) => {
    if (level === 1) {
      return {
        id: uuidv4(), // Avoid collision after creating multiple instantly
        0: baseMessage.trim(),
        1: baseMessage.trim(),
        2: "",
        3: "",
        4: "",
        keywords: [],
      };
    }
    return {
      id: uuidv4(), // Avoid collision after creating multiple instantly
      0: baseMessage.trim(),
      1: "",
      2: "",
      3: "",
      4: "",
      keywords: [],
    };
  };

  activateWord = (id) => (e) => {
    if (!this.state.areLLMToolsEnabled) return;
    let { rambleBoxes } = this.state;
    const index = rambleBoxes.findIndex((r) => r.id === id);
    if (index === -1) {
      return;
    }

    const rambleBoxKeywords = new Set(rambleBoxes[index].keywords) ?? new Set();
    let word = e.target.innerText.trim().toLowerCase();

    if (word in stopWordSet) {
      this.handleSnackText("You can't select a stop word!", "error");
    } else if (rambleBoxKeywords.has(word)) {
      rambleBoxKeywords.delete(word);
    } else {
      rambleBoxKeywords.add(word);
    }

    rambleBoxes[index].keywords = Array.from(rambleBoxKeywords);

    this.setState({ rambleBoxes });

    historyapi.save("selection", "activate-word", {
      word,
      id,
      index,
      keywords: Array.from(rambleBoxKeywords),
    });
  };

  addRambleBox = () => {
    const { activeRambleBox, respeakingRambleBox } = this.state;
    if (activeRambleBox) this.stopAndSaveSpeech();
    if (respeakingRambleBox !== -1) {
      this.scrollToId(respeakingRambleBox);
      this.handleSnackText("Cannot add a new box while respeaking.", "error");
      return;
    }

    const newRambleBox = this.makeNewRambleBox();

    this.setState(
      (prevState) => ({
        rambleBoxes: this.combineRambleBoxStates(
          prevState.rambleBoxes,
          [newRambleBox],
          prevState.rambleBoxes.length,
          (r) => true
        ),
        activeRambleBox: newRambleBox.id,
      }),
      () => {
        this.props.restartRecording();
        this.scrollToId(newRambleBox.id);
        this.handleSnackText("Starting recording.", "info");
      }
    );
    historyapi.save("dictation", "start-new-ramble", {
      boxId: newRambleBox.id,
    });
  };

  addNewRambleOnIndex = async (baseMessage, index) => {
    const newRambleBox = this.makeNewRambleBox(baseMessage, 1);
    this.setState(
      (prevState) => ({
        rambleBoxes: this.combineRambleBoxStates(
          prevState.rambleBoxes,
          [newRambleBox],
          index,
          (r) => true
        ),
        llmOrManualMod: prevState.llmOrManualMod.set(newRambleBox.id, Date.now()),
      }),
      () => {
        this.setRakeKeywords(newRambleBox.id);
        this.updateMultiSummaryStream(newRambleBox.id, { requestClean: false });
      }
    );
  };

  scrollToId = (id) => {
    let active = document.getElementById(id);
    if (active) {
      active.scrollIntoView({
        behavior: "smooth",
        block: "start",
        inline: "nearest",
      });
    }
  };

  recordSpeech = (id) => {
    const { activeRambleBox, UIVersion, rambleBoxes, respeakingRambleBox } = this.state;
    const index = rambleBoxes.findIndex((r) => r.id === id);

    // logic for first recording
    if (id === activeRambleBox) {
      return; // nothing to do here, though this shouldn't be possible
    }

    if (activeRambleBox !== -1) {
      this.stopAndSaveSpeech();
    } else {
      this.setState({ activeRambleBox: id });
    }

    // logic for raw text insertion
    if (UIVersion === "A") {
      let textarea = document.getElementById("uia-textfield");
      let isFocused = document.activeElement === textarea;
      let cursorPosition = textarea.value.length; // append when unfocused
      if (isFocused) cursorPosition = textarea.selectionStart; // else get cursor position
      this.setState({ activeRambleBox: id, cursorPosition });
    } else {
      // logic for respeaking
      if (respeakingRambleBox !== -1) {
        this.handleRespeak(respeakingRambleBox, "cancel");
      } else if (rambleBoxes[index][1].length > 0) {
        this.setState({ respeakingRambleBox: id, activeRambleBox: -1 });
      }
    }

    this.props.restartRecording();
    this.handleSnackText("Starting recording.", "info");
    historyapi.save("dictation", "record-speech", {
      boxId: activeRambleBox,
    });
  };

  stopAndSaveSpeech = () => {
    const { currentRecordingMessage, stopRecording } = this.props;
    const { activeRambleBox, rambleBoxes } = this.state;
    const activeIndex = rambleBoxes.findIndex((r) => r.id === activeRambleBox);
    if (activeIndex === -1) return;
    rambleBoxes[activeIndex][0] += currentRecordingMessage;
    this.setState({ rambleBoxes, activeRambleBox: -1 });
    // this.setRakeKeywords(activeRambleBox);
    // this.updateMultiSummaryStream(activeRambleBox);
    this.updateMultiSummaryStream(activeRambleBox, { shouldSetKeywords: true });
    stopRecording();
    this.handleSnackText("Stopped recording.", "info");
    historyapi.save("dictation", "stop-recording", {
      boxId: activeRambleBox,
    });
  };

  deleteSpeech = (id) => {
    let { rambleBoxes, viewLevel } = this.state;
    const index = rambleBoxes.findIndex((r) => r.id === id);
    if (index === -1) {
      this.handleSnackText(`Deleting box without id`, "error");
      return console.error(`Deleting box without id`);
    }
    const text = rambleBoxes[index][viewLevel];
    // A better version of this would be to reuse the internal modal. Simple for now though.
    if (text.split(" ").filter((s) => s.length > 0).length > 0) {
      if (!window.confirm(`Are you sure you want to delete this box?\n\nText:${text}`)) return;
    }

    rambleBoxes = rambleBoxes.filter((r) => r.id !== id);
    this.setState({ rambleBoxes });
    historyapi.save("editing", "delete-ramble", {
      boxId: id,
    });
  };

  handleRespeak = (id, action, ctx) => {
    if (id === -1) return;
    const { respeakingRambleBox, rambleBoxes } = this.state;
    const { currentRecordingMessage, stopRecording } = this.props;

    const respeakingIndex = rambleBoxes.findIndex((r) => r.id === respeakingRambleBox);
    let currentText = rambleBoxes[respeakingIndex][0];
    let newText = "";

    switch (action) {
      case "add":
        newText = currentText + " " + currentRecordingMessage;
        this.updateRambleText(id, newText);
        stopRecording();
        this.setState(
          (prevState) => ({
            lastClean: prevState.lastClean.set(id, rambleBoxes[respeakingIndex][1]),
          }),
          () => {
            llmapi
              .postStreamingResponseForSummary(
                currentRecordingMessage,
                1,
                rambleBoxes[respeakingIndex].keywords, // This is where user keywords get passed in
                "gpt-4",
                id,
                false
              )
              .then(() => {
                this.setState({ respeakingRambleBox: -1 }, () => {
                  this.setRakeKeywords(id);
                  this.updateMultiSummaryStream(id, { requestClean: false });
                });
              });
          }
        );
        break;
      case "replace":
        newText = currentRecordingMessage;
        this.updateRambleText(id, newText);
        stopRecording();
        this.setState({ respeakingRambleBox: -1 }, () => {
          this.setRakeKeywords(id);
          this.updateMultiSummaryStream(id, { requestClean: true, replaceClean: false });
        });
        break;
      case "cancel":
        newText = currentText;
        this.updateRambleText(id, newText);
        stopRecording();
        this.setState({ respeakingRambleBox: -1 });
        break;
      case "insert":
        newText =
          currentText.slice(0, ctx.start).trim() +
          " " +
          currentRecordingMessage +
          " " +
          currentText.slice(ctx.end).trim();
        this.updateRambleText(id, newText);
        stopRecording();
        this.setState({ respeakingRambleBox: -1 }, () => {
          this.setRakeKeywords(id);
          this.updateMultiSummaryStream(id, { requestClean: true, replaceClean: false });
        });
        break;
      default:
        return;
    }

    historyapi.save("editing", "respeak", {
      boxId: id,
      action,
      newText,
    });
  };

  onDragStart() {
    // Adds a bit of haptic feedback
    if (window.navigator.vibrate) {
      window.navigator.vibrate(100);
    }
  }

  // a little function to help us with reordering the result
  reorder = (list, startIndex, endIndex) => {
    const result = Array.from(list);
    const [removed] = result.splice(startIndex, 1);
    result.splice(endIndex, 0, removed);

    return result;
  };

  handleReorder = (result) => {
    // Updates rambleBoxes array on reordering
    const { rambleBoxes } = this.state;

    if (result.combine) {
      this.mergeBoxes(result.draggableId, result.combine.draggableId);
      return;
    }

    // dropped outside the list
    if (!result.destination) {
      return;
    }

    if (result.destination.index === result.source.index) {
      return;
    }

    const newRambleBoxes = this.reorder(rambleBoxes, result.source.index, result.destination.index);

    this.setState({ rambleBoxes: newRambleBoxes });
    historyapi.save("editing", "move-ramble", {
      boxId: rambleBoxes[result.source.index].id,
      oldIndex: result.source.index,
      newIndex: result.destination.index,
    });
  };

  updateMultiSummaryStream = async (id, opts = {}) => {
    const { areLLMToolsEnabled } = this.state;
    const defaultOpts = { requestClean: true, replaceClean: false, shouldSetKeywords: false };
    const actualOpts = Object.assign({}, defaultOpts, opts);
    const { requestClean, replaceClean, shouldSetKeywords } = actualOpts;
    if (!areLLMToolsEnabled) return;

    // console.log("Updating multi summary stream for box", id, rambleBoxes.find((box) => box.id === id))

    if (requestClean) {
      debounce(() => {
        this.requestSummaryStreaming(id, 1, replaceClean).then(() => {
          for (const level of [2, 3, 4]) {
            debounce(() => {
              this.requestSummaryStreaming(id, level);
            }, 150)();
          }
          if (shouldSetKeywords) {
            this.setRakeKeywords(id);
          }
        });
      }, 150)();
    } else {
      for (const level of [2, 3, 4]) {
        debounce(() => {
          this.requestSummaryStreaming(id, level);
        }, 150)();
      }
    }
  };

  requestSummaryStreaming = async (id, level, replace = true) => {
    const { rambleBoxes, areLLMToolsEnabled } = this.state;
    if (!areLLMToolsEnabled) return;

    const initialBox = rambleBoxes.find((box) => box.id === id);
    if (!initialBox) return console.error(`No box found with id: ${id}`);
    try {
      console.log("Requesting summary for box", id, "at level", level);
      const res = await llmapi.postStreamingResponseForSummary(
        initialBox[level === 1 ? 0 : 1],
        level,
        initialBox.keywords, // This is where user keywords get passed in
        "gpt-4",
        id,
        replace
      );
      const content = res.data;
      this.setState(
        (prevState) => ({
          rambleBoxes: prevState.rambleBoxes.map(this.updateBox({ id, content, level })),
        }),
        () => {
          historyapi.save("summary", "auto-summary", {
            boxId: id,
            content,
            level,
            // newRambleBox, // would be a nicer format to use but not in scope.
          });
        }
      );
      return;
    } catch (e) {
      console.error("Summary Streaming:", e);
    }
  };

  openEditWithLLM = async (id) => {
    this.setState({ LLMcommandTargetId: id }, this.toggleCustomPromptModal);
  };

  applyLLMCommandToRambleBox = async () => {
    const {
      customPrompt,
      LLMcommandTargetId,
      rambleBoxes,
      areLLMToolsEnabled,
      useKeywordsWithCustomPrompt,
    } = this.state;
    const id = LLMcommandTargetId;
    if (!areLLMToolsEnabled) {
      this.handleSnackText(`LLM tools are not enabled.`, "error");
      return;
    }
    if (!customPrompt || customPrompt === "") {
      this.handleSnackText(`Empty text command!`, "error");
      return;
    }
    const initialBox = rambleBoxes.find((box) => box.id === id);
    if (!initialBox) {
      this.handleSnackText(`No box found with id: ${id}`, "error");
      return;
    }
    this.toggleCustomPromptModal();
    this.setState({ LLMcommandTargetId: -1 });
    const text = initialBox[1];
    const level = 1;
    const withKeywordSuffix = "\n Keywords: " + initialBox.keywords.join(", ");
    const res = await llmapi.callStreamingResponseForLlmQuery(
      customPrompt + (useKeywordsWithCustomPrompt ? withKeywordSuffix : ""),
      text,
      {
        rambleBoxId: id,
        level,
      }
    );
    const content = res.data;
    console.log("LLM Command Response:", content);
    this.setState(
      (prevState) => ({
        rambleBoxes: prevState.rambleBoxes.map(
          this.updateBox({ id, content, level, keywords: [] })
        ),
      }),
      () => {
        historyapi.save("edit", "open-ended-edit", {
          boxId: id,
          content,
          level,
        });
        this.setRakeKeywords(id);
        this.updateMultiSummaryStream(id, { requestClean: false });
      }
    );
  };

  // Used for merging two boxes using drag and drop
  mergeBoxes = async (
    sourceBox,
    targetBox,
    mergeFunction = (selectedText) => selectedText.join(" "),
    extraBoxes = [],
    wasLLM = false
  ) => {
    // If the source and target are the same, do nothing
    if (sourceBox === targetBox) return;
    this.setState({
      lastLLMUpdate: new Date(),
      mergingBoxIds: new Set([sourceBox, targetBox, ...extraBoxes]),
    });
    let { rambleBoxes, areLLMToolsEnabled, areBlockToolsEnabled } = this.state;
    if (!areBlockToolsEnabled && !areLLMToolsEnabled) return;

    this.handleSnackText("Starting merge.", "info");

    const selectedIds = [sourceBox, targetBox, ...extraBoxes];
    const select = (id) => rambleBoxes.findIndex((r) => r.id === id);
    const selectedIndices = selectedIds.map(select).filter((x) => x >= 0);
    selectedIndices.sort((a, b) => a - b); // sort ascending to maintain merge order
    const selectedText = selectedIndices.map((i) => rambleBoxes[i][1]);

    const mergedText = await mergeFunction(selectedText);

    const newRambleBox = this.makeNewRambleBox(mergedText, 1);
    const newIndex = Math.min(...selectedIndices);

    this.setState(
      (prevState) => ({
        rambleBoxes: this.combineRambleBoxStates(
          prevState.rambleBoxes,
          [newRambleBox],
          newIndex,
          (r) => r.id !== targetBox && !extraBoxes.includes(r.id) && r.id !== sourceBox
        ),
        mergingBoxIds: new Set(),
        llmOrManualMod: prevState.llmOrManualMod.set(newRambleBox.id, Date.now()),
      }),
      () => {
        this.setRakeKeywords(newRambleBox.id);
        this.updateMultiSummaryStream(newRambleBox.id, { requestClean: false });
      }
    );

    this.handleSnackText("Successfully merged.", "success");
    historyapi.save("editing", "merge", {
      selectedText,
      mergedText,
      newRambleBox,
      wasLLM,
    });
  };

  combineRambleBoxStates = (prevRambleBoxes, newRambleBoxes, newIndex, filterFunc) => {
    // Appending back into the rambleBoxes array
    let newRambleBoxState = prevRambleBoxes.filter(filterFunc);
    newRambleBoxState.splice(newIndex, 0, ...newRambleBoxes);
    return newRambleBoxState;
  };

  mergeBoxesWithLLM = (autoMergeBoxIds) => {
    if (autoMergeBoxIds.size < 2) {
      this.handleSnackText("Must select at least two boxes for semantic merging.", "error");
      return;
    }

    const { rambleBoxes } = this.state;
    const allBoxes = Array.from(autoMergeBoxIds);
    const targetBox = allBoxes[0];
    const sourceBox = allBoxes[1];
    let extraBoxes = [];
    if (allBoxes.length > 2) {
      extraBoxes = allBoxes.slice(2);
    }

    const selectedRambleBoxes = allBoxes
      .map((id) => rambleBoxes.find((r) => r.id === id))
      .filter((x) => x);
    const keywords = selectedRambleBoxes.map((box) => box.keywords).flat();

    const llmMergeFunction = async (selectedText) => await llmapi.mergeText(selectedText, keywords);

    this.setState({ autoMergeBoxIds: new Set() });
    return this.mergeBoxes(sourceBox, targetBox, llmMergeFunction, extraBoxes, true);
  };

  editRamble = (id) => {
    const { rambleBoxes, activeRambleBox, editingRambleBox } = this.state;

    // If there is an active RambleBox (a box currently being spoken into), save its content
    if (activeRambleBox !== -1) this.stopAndSaveSpeech();

    // Check if there's a RambleBox currently being edited and if it's different from the new one
    if (editingRambleBox !== -1 && editingRambleBox !== id) {
      const currentEditingBox = rambleBoxes.find((box) => box.id === editingRambleBox);
      let editedText = document.getElementById("editingRamble").innerText;
      if (currentEditingBox) {
        this.updateRambleText(editingRambleBox, editedText, 1);
      }
    }

    // Toggle the editing state
    if (editingRambleBox === id || id === -1) {
      this.setState({ editingRambleBox: -1 });
    } else {
      this.setState({
        viewLevel: 1,
        editingRambleBox: id,
      });
    }

    historyapi.save("editing", "edit-ramble", {
      boxId: id,
    });
  };

  updateRambleText = (id, text, viewLevel = 0) => {
    let { rambleBoxes } = this.state;
    let box = rambleBoxes.find((r) => r.id === id);
    if (!box) return console.error(`No box found with id: ${id}`);
    box[viewLevel] = text;

    // Make a toast notification updated successfully.
    this.handleSnackText("Updated ramble.", "success");

    // Regenerate summaries for this box
    this.setState(
      (prevState) => ({
        rambleBoxes: prevState.rambleBoxes.map(
          this.updateBox({ id, content: text, level: viewLevel })
        ),
      }),
      () => {
        this.setState((prevState) => ({
          rambleBoxes: prevState.rambleBoxes.map(
            this.updateBoxKeywords(id, this.getRakeKeywordsFromText(text))
          ),
        }));
      }
    );

    historyapi.save("editing", "update-ramble", {
      boxId: id,
      text,
    });
  };

  splitRamble = async (id) => {
    let { rambleBoxes, areLLMToolsEnabled, areBlockToolsEnabled } = this.state;
    if (!areBlockToolsEnabled && !areLLMToolsEnabled) return;

    // Get the ramble text from the ID
    let { viewLevel } = this.state;
    const selected = rambleBoxes.find((r) => r.id === id);
    if (!selected) return console.error(`Splitting box without id`);
    const rawText = selected[viewLevel];
    this.setState({ splitBoxId: id });

    // Get the active words
    const activeWordsArray = selected.keywords;

    // Determine wheter to split or segment based on active words
    let splitText = null;

    this.handleSnackText("Starting split.", "info");
    splitText = await llmapi.segmentText(rawText);
    try {
      splitText = JSON.parse(splitText);
    } catch {
      this.handleSnackText("Error parsing split text, please try again.", "error");
      return;
    }

    // Delete the old ramble box
    const oldIndex = rambleBoxes.findIndex((r) => r.id === id);

    // Add new original boxes in its place
    const newBoxes = [];
    splitText.forEach((text) => {
      const box = this.makeNewRambleBox(text, 1);
      newBoxes.push(box);
    });

    this.setState(
      (prevState) => ({
        rambleBoxes: this.combineRambleBoxStates(
          prevState.rambleBoxes,
          newBoxes,
          oldIndex,
          (r) => r.id !== id
        ),
        splitBoxId: null,
        llmOrManualMod: (() => {
          for (const box of newBoxes) {
            prevState.llmOrManualMod.set(box.id, Date.now());
          }
          return prevState.llmOrManualMod;
        })(),
      }),
      () => {
        // Update summaries for new boxes
        newBoxes.forEach((box) => {
          this.setRakeKeywords(box.id);
          this.updateMultiSummaryStream(box.id, { requestClean: false });
        });
      }
    );
    historyapi.save("editing", "split-ramble", {
      selected,
      activeWordsArray,
      splitText,
      wasLLM: true,
    });
  };

  formatText = async (id) => {
    const rambleBoxes = this.state.rambleBoxes;
    const rambleBox = rambleBoxes.find((r) => r.id === id);
    if (rambleBox === undefined) {
      return;
    }
    const rambleBoxText = rambleBox[0];
    const formattedText = await llmapi.formatText(rambleBoxText);

    rambleBoxes.find((r) => r.id === id)[0] = formattedText;
    this.setState({ rambleBoxes });
  };

  toggleSettingsModal = () => {
    this.setState((prevState) => ({ isSettingsModalOpen: !prevState.isSettingsModalOpen }));
  };

  toggleCustomPromptModal = () => {
    const { isCustomPromptModalOpen } = this.state;
    if (isCustomPromptModalOpen) {
      // open -> close
      this.setState({ isCustomPromptModalOpen: false, LLMcommandTargetId: -1 });
    } else {
      // close -> open
      this.setState({ isCustomPromptModalOpen: true });
    }
  };

  updateUIVersion = ({ target }) => {
    const UIVersion = target.value;
    let areLLMToolsEnabled = false;
    let areBlockToolsEnabled = false;
    let activeRambleBox = -1;
    let editingRambleBox = -1;
    let viewLevel = 1;

    // Save it into localStorage to persist across reloads.
    localStorage.setItem("UIVersion", UIVersion);
    historyapi.context.UIVersion = UIVersion;

    if (UIVersion === "A") {
      console.log("Activating UI Version A");
      this.clearKeywords();
    } else if (UIVersion === "B") {
      console.log("Activating UI Version B");
      this.clearKeywords();
      areBlockToolsEnabled = true;
    } else if (UIVersion === "C") {
      this.generateRakeKeywords();
      console.log("Activating UI Version C");
      areBlockToolsEnabled = true;
      areLLMToolsEnabled = true;
    }

    // Change UI version, clear active ramble box and related data.
    this.setState({
      UIVersion,
      areLLMToolsEnabled,
      activeRambleBox,
      editingRambleBox,
      areBlockToolsEnabled,
      viewLevel,
    });
  };

  updateCustomPrompt = (cb) => {
    // const customPrompt = target.value;
    const customPrompt = document.getElementById("custom-prompt").value;
    this.setState({ customPrompt }, cb);
  };

  handleZoomChange = ({ target }) => {
    this.setState({ viewLevel: +target.value });
    historyapi.save("view", "zoom-change", {
      viewLevel: +target.value,
    });
  };

  handleSnackClose = (event, reason) => {
    if (reason === "clickaway") {
      return;
    }

    this.setState({ snackOpen: false });
  };

  handleSnackText = (text, severity) => {
    this.setState({ snackOpen: true, snackText: text, severity });
  };

  wordCount = (rambleBoxes, currentRecordingMessage) => {
    const { viewLevel } = this.state;
    let words = 0;

    if (this.state.UIVersion === "A") {
      if (rambleBoxes.length > 0) {
        rambleBoxes = [rambleBoxes[0]];
      } else {
        rambleBoxes = [];
      }
    }

    if (rambleBoxes.length === 0) return words;
    console.log("rambleBoxes", rambleBoxes);
    rambleBoxes.forEach((rambleBox) => {
      const potentialWords = rambleBox ? rambleBox[viewLevel].split(" ") : [];
      words += potentialWords.filter((word) => word !== "").length;
    });
    words += currentRecordingMessage.split(" ").filter((word) => word !== "").length;
    return words;
  };

  renderHeader = () => {
    const { rambleBoxes, UIVersion } = this.state;
    const { currentRecordingMessage } = this.props;
    return (
      <nav>
        {this.renderTitle()}
        <div className="upperControls">
          <span>{this.wordCount(rambleBoxes, currentRecordingMessage)} words</span>
          <Button onClick={this.copyRambleBoxes}>
            {UIVersion === "A" ? "Copy Text" : "Copy All Text"}
          </Button>
          <Button onClick={this.toggleSettingsModal}>
            <Settings />
          </Button>
        </div>
      </nav>
    );
  };

  renderTitle = () => {
    const { title, editingTitle } = this.state;
    const toggle = (confirm = false) => {
      if (editingTitle) {
        if (confirm) {
          let newTitle = document.getElementById("edit-title-input").value;
          if (newTitle === "") newTitle = this.defaultState.title;
          this.setState({ title: newTitle });
          // localStorage.setItem("rambleTitle", newTitle);
          this.props.setTitle(newTitle);
        }
      } else {
        setTimeout(() => {
          // Focus the input after it renders
          const input = document.getElementById("edit-title-input");
          if (input) {
            if (input.value === this.defaultState.title) {
              input.value = "";
            }
            input.focus();
            input.select();
          }
        }, 50);
      }

      // Toggle the editing state
      this.setState({ editingTitle: !editingTitle });
    };

    const checkEnter = (event) => {
      if (event.keyCode === 13) toggle(true); // keycode for enter
    };

    if (!editingTitle) {
      return (
        <h1 className="edit-title" onClick={toggle}>
          {title}
        </h1>
      );
    } else {
      return (
        <h1>
          <input
            type="text"
            id="edit-title-input"
            defaultValue={title}
            onKeyDown={checkEnter}
            onBlur={() => toggle(true)}
          />
        </h1>
      );
    }
  };

  renderAutoMerge = () => {
    const { autoMergeBoxIds, areLLMToolsEnabled } = this.state;
    if (!areLLMToolsEnabled) return null;
    return (
      <Button onClick={() => this.mergeBoxesWithLLM(autoMergeBoxIds)}>
        <CallMerge />
        Semantic Merge
      </Button>
    );
  };

  renderRambleBoxes = () => {
    const { currentRecordingMessage } = this.props;
    const {
      rambleBoxes,
      viewLevel,
      activeRambleBox,
      editingRambleBox,
      respeakingRambleBox,
      splitBoxId,
      mergingBoxIds,
      autoMergeBoxIds,
      areLLMToolsEnabled,
      UIVersion,
      llmOrManualMod,
    } = this.state;

    let shownRambles = rambleBoxes;
    let basic = false;
    if (UIVersion === "A") {
      if (rambleBoxes.length > 0) {
        shownRambles = [rambleBoxes[0]];
        basic = true;
      } else {
        const newRambleBox = this.makeNewRambleBox();
        this.setState((prevState) => ({
          rambleBoxes: this.combineRambleBoxStates(
            prevState.rambleBoxes,
            [newRambleBox],
            prevState.rambleBoxes.length,
            (r) => true
          ),
        }));
      }
    }
    if (UIVersion === "B") {
      basic = true;
    }

    return (
      <DragDropContext onDragStart={this.onDragStart} onDragEnd={this.handleReorder}>
        <Droppable droppableId="droppable" isCombineEnabled={true}>
          {(provided) => (
            <div id="rambleBoxContainer" {...provided.droppableProps} ref={provided.innerRef}>
              {shownRambles.map((rambleBox, index) => {
                if (!rambleBox) return null;
                const id = rambleBox.id;
                const active = id === activeRambleBox;
                const editing = id === editingRambleBox;
                const respeaking = id === respeakingRambleBox;
                let rambleView = rambleBox[viewLevel];
                if (active && !respeaking) rambleView += currentRecordingMessage;

                // // If the summary viewLevel is shorter than actual transcript, just display the cleaned up transcript
                // const lengthLimits = { 2: 20, 3: 10, 4: 5 };
                // const wordCount = rambleBox[0].split(" ").length;
                // if (lengthLimits[viewLevel] && wordCount <= lengthLimits[viewLevel]) {
                //   rambleView = rambleBox[1];
                // }

                let keywords = new Set();
                if (rambleBox.keywords && rambleBox.keywords.length > 0) {
                  keywords = new Set(rambleBox.keywords);
                }

                const addAutoMergeId = (isAdd, id) => {
                  if (isAdd) {
                    this.setState({ autoMergeBoxIds: autoMergeBoxIds.add(id) });
                  } else {
                    const autoMergeBoxIdsCopy = new Set(autoMergeBoxIds);
                    autoMergeBoxIdsCopy.delete(id);
                    this.setState({ autoMergeBoxIds: autoMergeBoxIdsCopy });
                  }
                };

                const addNewRamble = (baseMessage, index) =>
                  this.addNewRambleOnIndex(baseMessage, index);

                const isRecentMergeOrSplitResult =
                  llmOrManualMod.has(id) && llmOrManualMod.get(id) > Date.now() - 5000;

                return (
                  <RambleBox
                    id={id}
                    index={index}
                    key={`ramblebox-${id}`}
                    text={rambleView}
                    viewLevel={viewLevel}
                    basic={basic}
                    active={active}
                    editing={editing}
                    areLLMToolsEnabled={areLLMToolsEnabled}
                    respeaking={respeaking}
                    activeWords={keywords}
                    addNewRamble={addNewRamble}
                    activateWord={this.activateWord}
                    editRamble={() => this.editRamble(id)}
                    splitRamble={() => this.splitRamble(id)}
                    recordSpeech={() => this.recordSpeech(id)}
                    deleteSpeech={() => this.deleteSpeech(id)}
                    stopSpeech={() => this.stopAndSaveSpeech()}
                    updateRamble={(text, viewLevel = 1) =>
                      this.updateRambleText(id, text, viewLevel)
                    }
                    addToLLMOrManualMod={(id) => {
                      this.setState((prevState) => ({
                        llmOrManualMod: prevState.llmOrManualMod.set(id, Date.now()),
                      }));
                    }}
                    removeFromLLMOrManualMod={(id) => {
                      const { llmOrManualMod } = this.state;
                      llmOrManualMod.delete(id);
                      this.setState({ llmOrManualMod });
                    }}
                    handleRespeak={(action, ctx) => this.handleRespeak(id, action, ctx)}
                    openEditWithLLM={() => this.openEditWithLLM(id)}
                    currentRecordingMessage={currentRecordingMessage}
                    mergeBoxes={(sourceBox, targetBox) => this.mergeBoxes(sourceBox, targetBox)}
                    isDisabled={id === splitBoxId || mergingBoxIds.has(id)}
                    isRecentMergeOrSplitResult={isRecentMergeOrSplitResult}
                    autoMergeSelect={(e) => addAutoMergeId(e.target.checked, id)}
                    updateSummary={() => this.updateMultiSummaryStream(id, { requestClean: false })}
                    isLLMtarget={id === this.state.LLMcommandTargetId}
                    UIVersion={UIVersion}
                  />
                );
              })}
              {provided.placeholder}
            </div>
          )}
        </Droppable>
      </DragDropContext>
    );
  };

  renderSlidingWindow = () => {
    const windowLength = 9;
    const { activeRambleBox } = this.state;
    if (activeRambleBox !== -1) {
      const { currentRecordingMessage } = this.props;
      let lastWords = currentRecordingMessage.split(" ").slice(-windowLength).join(" ");
      return (
        <div className="slidingWindow" onClick={() => this.scrollToId(activeRambleBox)}>
          {" "}
          <div className="speech-text">{lastWords}</div>{" "}
        </div>
      );
    } else {
      return null;
    }
  };

  renderSettingsModal = () => {
    const { isSettingsModalOpen, UIVersion } = this.state;
    const pId = this.props.pId;
    const runAndClose = (fn) => {
      if (fn) fn();
      this.toggleSettingsModal();
    };

    return (
      <Modal
        open={isSettingsModalOpen}
        onClose={this.toggleSettingsModal}
        aria-labelledby="settings-modal-title"
        aria-describedby="settings-modal-description"
      >
        <Box className="modal-box">
          <Box className="modal-header">
            <h2 id="settings-modal-title">Settings</h2>
            <IconButton
              aria-label="close"
              className="pull-right"
              onClick={this.toggleSettingsModal}
            >
              <Cancel />
            </IconButton>
          </Box>

          <hr />
          <FormControl>
            <FormLabel id="demo-row-radio-buttons-group-label">UI Version</FormLabel>
            <RadioGroup
              row
              aria-labelledby="demo-row-radio-buttons-group-label"
              name="row-radio-buttons-group"
              onChange={this.updateUIVersion}
              value={UIVersion}
            >
              <FormControlLabel value="A" control={<Radio />} label="Text and Speech Editor" />
              {/* <FormControlLabel
                value="B"
                control={<Radio />}
                label="B: Manual Iterative Drafting"
              /> */}
              <FormControlLabel
                value="C"
                control={<Radio />}
                label="LLM-assisted Iterative Drafting"
              />
            </RadioGroup>
          </FormControl>

          <hr />
          <FormLabel id="demo-row-radio-buttons-group-label">App Data</FormLabel>
          <Button onClick={() => runAndClose(this.exportTXT)}>Download Text File</Button>
          {/* <Button onClick={this.loadExample}>Load Example Data</Button> */}
          <Button onClick={this.loadExampleForStudy}>Load Study Example Data</Button>
          <Button onClick={this.confirmClearData}>Clear Data</Button>
          <Button onClick={() => runAndClose(this.exportJSON)}>Export JSON</Button>
          <input id="files" type="file" onChange={this.handleFileSelect} multiple="" />
          <Button onClick={this.importJSON}>Import JSON</Button>

          <hr />
          <FormLabel id="demo-row-radio-buttons-group-label">Participant ID</FormLabel>
          {/* <Button onClick={this.regenerateSessionId}>Regenerate</Button> */}
          <small className="pull-right">{pId}</small>
        </Box>
      </Modal>
    );
  };

  renderCustomPromptModal = () => {
    const { isCustomPromptModalOpen, customPrompt, useKeywordsWithCustomPrompt } = this.state;

    return (
      <Modal
        open={isCustomPromptModalOpen}
        onClose={() => {
          this.updateCustomPrompt();
          this.toggleCustomPromptModal();
        }}
        aria-labelledby="settings-modal-title"
        aria-describedby="settings-modal-description"
      >
        <Box className="modal-box">
          <Box className="modal-header">
            <h2 id="settings-modal-title">LLM Commands</h2>
            <IconButton
              aria-label="close"
              className="pull-right"
              onClick={this.toggleCustomPromptModal}
            >
              <Cancel />
            </IconButton>
          </Box>

          <FormControl className="custom-prompt-modal-content">
            <FormLabel id="demo-row-radio-buttons-group-label">
              Specify what changes you'd like to make to the text.
            </FormLabel>
            <TextField
              id="custom-prompt"
              multiline
              defaultValue={customPrompt}
              // onChange={this.updateCustomPrompt} // was slow, save on apply instead
              maxRows={10}
            />
            <FormControlLabel
              control={
                <Checkbox
                  checked={useKeywordsWithCustomPrompt}
                  onChange={() =>
                    this.setState((prevState) => ({
                      useKeywordsWithCustomPrompt: !prevState.useKeywordsWithCustomPrompt,
                    }))
                  }
                  inputProps={{ "aria-label": "controlled" }}
                  label="Include ramble keywords in prompt"
                />
              }
              label="Include keywords as context"
              labelPlacement="end"
            />
          </FormControl>
          <Button
            onClick={() => {
              this.updateCustomPrompt(this.applyLLMCommandToRambleBox);
            }}
          >
            Apply
            <span />
            <AutoFixHigh />
          </Button>
        </Box>
      </Modal>
    );
  };

  renderFooter = () => {
    const { viewLevel, areLLMToolsEnabled, UIVersion, editingRambleBox } = this.state;
    if (UIVersion === "A") return;
    const isEditing = editingRambleBox !== -1;

    const marks = [
      {
        value: 0,
        label: "Raw",
      },
      {
        value: 1,
        label: "Full",
      },
      {
        value: 2,
        label: "50%",
      },
      {
        value: 3,
        label: "25%",
      },
      {
        value: 4,
        label: "10%", // just to make it look nice
        // label: "5W",
      },
    ];

    return (
      <div className="footer">
        <div className="slider-container">
          {this.renderSlidingWindow()}
          <div className="controls">
            {areLLMToolsEnabled && this.renderAutoMerge()}
            <Button variant="outlined" onClick={this.addRambleBox} startIcon={<Add />}>
              Ramble
            </Button>
            {/* {areLLMToolsEnabled && (
            <Button onClick={this.toggleCustomPromptModal} startIcon={<AutoFixHigh />}>
              Command
            </Button>
          )} */}
            {areLLMToolsEnabled && (
              <Fragment>
                <div className="break"></div>
                <Box className="slider">
                  <Slider
                    aria-label="Zoom"
                    value={viewLevel}
                    onChange={this.handleZoomChange}
                    step={1}
                    track={false}
                    marks={marks}
                    min={1}
                    max={4}
                    valueLabelDisplay="off"
                    disabled={isEditing}
                  />
                </Box>
              </Fragment>
            )}
          </div>
        </div>
      </div>
    );
  };

  renderSnack = () => {
    return (
      <Snackbar open={this.state.snackOpen} autoHideDuration={6000} onClose={this.handleSnackClose}>
        <Alert severity={this.state.severity} onClose={this.handleSnackClose}>
          {this.state.snackText}
        </Alert>
      </Snackbar>
    );
  };

  render() {
    return (
      <div id="RambleEditor">
        {this.renderHeader()}
        {this.renderRambleBoxes()}
        {this.renderSettingsModal()}
        {this.renderCustomPromptModal()}
        {this.renderFooter()}
        {this.renderSnack()}
      </div>
    );
  }
}

RambleEditor = withDictation(RambleEditor);

class App extends Component {
  constructor(props) {
    super(props);
    let pId = localStorage.getItem("pId");
    if (!pId) {
      pId = uuidv4();
      localStorage.setItem("pId", pId);
      // pId = prompt("Please enter your participant ID");
      // if not a valid uuidv4-formatted string, make up a new one.
      // if (
      //   !pId ||
      //   !pId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      // ) {
      //   pId = uuidv4();
      //   alert("Invalid ID, using " + pId + " instead.");
      // }
    }
    this.state = {
      pId: pId,
      fileList: [], // [{ id: localStorage.getItem('sessionId'), title: localStorage.getItem('rambleTitle'), rambles: JSON.parse(localStorage.getItem('rambleBoxes')) }],
      showFileList: false,
    };
    this.state.selectedFile = this.state.fileList[0];
  }

  componentDidMount = () => {
    // get pId from local storage, or prompt if missing
    this.updateFileList();
  };

  updateFileList = async () => {
    // fetch from server
    let fileList = await fetch(`/api/files?pId=${this.state.pId}`, {
      method: "GET",
    }).then((res) => res.json());
    // if no files, create a new one
    if (fileList.length === 0) {
      fileList = [{ id: uuidv4(), title: "Untitled", rambles: [] }];
    }
    const selectedFileId = localStorage.getItem("selectedFileId");
    let selectedFile = fileList[0]; // Default to the first file
    // select the file from local storage if it exists
    if (selectedFileId) {
      const foundFile = fileList.find((file) => file.id === selectedFileId);
      if (foundFile) {
        selectedFile = foundFile;
      }
    }
    this.setState({ fileList, selectedFile });
  };

  addFile = () => {
    let file = { id: uuidv4(), title: "Untitled" };
    this.setState({ fileList: [...this.state.fileList, file], selectedFile: file });
  };

  saveFile = (file) => {
    // save to server
    fetch(`/api/files?pId=${this.state.pId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(file),
    });
    localStorage.setItem("selectedFileId", file.id);
    let newFiles = this.state.fileList.map((f) => (f.id === file.id ? file : f));
    this.setState({ fileList: newFiles, selectedFile: file });
    // localStorage.setItem("rambleBoxes", JSON.stringify(file.rambles));
    // localStorage.setItem("rambleTitle", file.title);
    // localStorage.setItem("sessionId", file.id);
  };

  selectFile = (file) => {
    this.setState({ selectedFile: file });
    localStorage.setItem("selectedFileId", file.id);
  };

  render() {
    return (
      <div className="App">
        {this.state.showFileList ? (
          <div className="file-list">
            <button className="close-button" onClick={() => this.setState({ showFileList: false })}>
              &times;
            </button>
            <h3>Saved Files</h3>
            {this.state.fileList.map((file) => (
              <div
                className={`file-list-item ${file === this.state.selectedFile && "selected"}`}
                onClick={() => this.selectFile(file)}
              >
                {file.title}
              </div>
            ))}
            <button className="new-button" onClick={this.addFile}>
              + New file &raquo;
            </button>
          </div>
        ) : (
          <div className="file-list-button" onClick={() => this.setState({ showFileList: true })}>
            ꠵
          </div>
        )}
        {this.state.selectedFile && (
          <RambleEditor
            fileId={this.state.selectedFile.id}
            getRambles={() => this.state.selectedFile?.rambles || []}
            setRambles={(rambles) => this.saveFile({ ...this.state.selectedFile, rambles })}
            getTitle={() => this.state.selectedFile?.title || "Untitled"}
            setTitle={(title) => this.saveFile({ ...this.state.selectedFile, title })}
            pId={this.state.pId}
          />
        )}
      </div>
    );
  }
}

export default App;
