import React, { Component, Fragment } from "react";
import { Draggable } from "react-beautiful-dnd";

import TextField from "@mui/material/TextField";
import { Checkbox } from "@mui/material";
import { Tooltip } from "@mui/material";
import IconButton from "@mui/material/IconButton";
import {
  Delete,
  Mic,
  Cancel,
  Edit,
  RadioButtonChecked,
  Replay,
  Merge,
  Check as CheckIcon,
  Add as AddIcon,
  AutoFixHigh,
  ContentCut,
  Autorenew,
} from "@mui/icons-material";

import { splitTextOnIndex } from "./utils";
import historyapi from "./historyapi";

class RambleBox extends Component {
  constructor(props) {
    super(props);
    this.textfieldRef = React.createRef();
  }

  handleEditToggle = () => {
    const { editing, editRamble } = this.props;
    if (editing) {
      this.confirmSpeech(); // If we're editing, save text.
    } else {
      editRamble(); // Mark this ramble for editing.
      // Wait for the DOM to update, then focus on the editing div.
      setTimeout(() => {
        const editDiv = document.getElementById("editingRamble");
        if (!editDiv) return console.error("Couldn't find editingRamble div.");
        editDiv.focus();
        document.execCommand("selectAll", false, null);
        document.getSelection().collapseToEnd();
      }, 200);
    }
  };

  confirmSpeech = () => {
    const { updateRamble, editRamble, updateSummary } = this.props;
    const editDiv = document.getElementById("editingRamble");
    if (!editDiv) return console.error("Couldn't find editingRamble div.");
    updateRamble(editDiv.innerText, 1);
    editRamble();
    setTimeout(updateSummary, 300); // wait for text to update pre summarization
  };

  handleKeyDown = (event) => {
    const {
      id,
      index,
      addNewRamble,
      updateRamble,
      updateSummary,
      editRamble,
      addToLLMOrManualMod,
      activeWords,
    } = this.props;

    const content = event.target.innerText;

    if (event.key === "Enter") {
      event.preventDefault();

      // Get the cursor position within the contentEditable div
      const sel = window.getSelection();
      const offset = sel.focusOffset;

      // Split the content based on the cursor's position
      const [contentBeforeCursor, contentAfterCursor] = splitTextOnIndex(content, offset);
      console.log("contentBeforeCursor", contentBeforeCursor);
      console.log("contentAfterCursor", contentAfterCursor);

      // Update the current Ramble with the content before the cursor
      updateRamble(contentBeforeCursor);
      addToLLMOrManualMod(id);

      // Create a new RambleBox with the content after the cursor
      addNewRamble(contentAfterCursor, index + 1);

      editRamble();

      setTimeout(updateSummary, 300); // wait for text to update pre summarization

      historyapi.save("editing", "split-ramble", {
        selected: id,
        activeWordsArray: activeWords,
        splitText: [contentBeforeCursor, contentAfterCursor],
        wasLLM: false,
      });
    } else {
      historyapi.save("editing", "update-ramble-manual", {
        boxId: id,
        text: content,
      });
    }
  };

  handleKeyDownTextArea = (event) => {
    // If we press a key that doesn't change the text, stop recording.
    const { active } = this.props;
    if (active) {
      if (
        event.key !== "ArrowLeft" &&
        event.key !== "ArrowRight" &&
        event.key !== "ArrowUp" &&
        event.key !== "ArrowDown"
      ) {
        event.preventDefault();
        this.props.stopSpeech();
      }
    }
  };

  handleChangeTextarea = (event) => {
    const { updateRamble } = this.props;

    // If respeaking, append text
    updateRamble(event.target.value);
    if (this.props.respeaking)
      this.props.handleRespeak("insert", this.getSelectionRange(this.textfieldRef));
  };

  cancelSpeech = () => {
    const { editRamble } = this.props;
    editRamble();
  };

  getSelectionRange = (ref) => {
    const textarea = ref.current?.querySelector('textarea[aria-invalid="false"]');
    if (textarea) {
      return {
        start: textarea.selectionStart,
        end: textarea.selectionEnd,
      };
    } else {
      return null;
    }
  };

  render() {
    let {
      id,
      index,
      basic,
      active,
      editing,
      respeaking,
      text,
      activateWord,
      activeWords,
      recordSpeech,
      stopSpeech,
      deleteSpeech,
      handleRespeak,
      currentRecordingMessage,
      isDisabled,
      isRecentMergeOrSplitResult,
      isLLMtarget,
      autoMergeSelect,
      UIVersion,
      splitRamble,
      openEditWithLLM,
      updateSummary,
      removeFromLLMOrManualMod,
    } = this.props;

    let className = "ramblebox";
    if (basic) className += " basic";
    if (active || respeaking) className += " active";
    if (editing) className += " editing";
    if (isDisabled) className += " disabled";
    if (isLLMtarget) className += " editing llm-target";
    if (isRecentMergeOrSplitResult) {
      className += " recent-merge-or-split-result";
      setTimeout(() => removeFromLLMOrManualMod(id), 2000);
    }
    if (!text) text = " ";

    const splitWords = text.split(" ");

    let textContent = null;
    if (UIVersion === "A") {
      textContent = (
        <TextField
          id="uia-textfield"
          ref={this.textfieldRef}
          fullWidth
          multiline
          className={"speech-text-field-version-a"}
          defaultValue={text}
          onKeyDown={this.handleKeyDownTextArea}
          onChange={this.handleChangeTextarea}
        />
      );
    } else if (editing) {
      textContent = (
        <div
          id={"editingRamble"}
          className="speech-text"
          suppressContentEditableWarning={true}
          onKeyDown={this.handleKeyDown}
          contentEditable
        >
          {text}
        </div>
      );
    } else if (respeaking) {
      textContent = <div className="speech-text disabled">{text}</div>;
    } else {
      textContent = (
        <div className="speech-text">
          {splitWords.map((word, i) => {
            return (
              <Keyword
                key={id + i}
                active={activeWords.has(word.trim().toLowerCase())} // Human selected keywords
                onClick={activateWord(id)}
                word={word}
              />
            );
          })}
        </div>
      );
    }

    let respeakingContent = null;
    let insertText = () => {
      handleRespeak("insert", this.getSelectionRange(this.textfieldRef));
    };

    if (UIVersion !== "A" && respeaking) {
      respeakingContent = (
        <div className="respeaking-container">
          <div className="respeaking-text">{currentRecordingMessage}</div>
          <div className="respeaking-controls">
            <div className="respeaking-label">Respeaking...</div>
            <div>
              <Tooltip title="Add">
                <IconButton onClick={() => handleRespeak("add")}>
                  <AddIcon />
                </IconButton>
              </Tooltip>
              <Tooltip title="Replace">
                <IconButton onClick={() => handleRespeak("replace")}>
                  <Replay />
                </IconButton>
              </Tooltip>
              {UIVersion === "A" && (
                <Tooltip title="Insert">
                  <IconButton onClick={insertText}>
                    <Merge />
                  </IconButton>
                </Tooltip>
              )}
              <Tooltip title="Cancel">
                <IconButton onClick={() => handleRespeak("cancel")}>
                  <Cancel />
                </IconButton>
              </Tooltip>
            </div>
          </div>
        </div>
      );
    }

    let controlClass = "ramble-controls";
    const hideMicIconInA = window.location.hash.includes("HIDEMIC");

    let rButtons = null;
    if (active) {
      rButtons = (
        <IconButton className="active" onClick={stopSpeech}>
          <RadioButtonChecked />
        </IconButton>
      );
    } else if (editing) {
      rButtons = (
        <IconButton onClick={this.confirmSpeech}>
          <CheckIcon />
        </IconButton>
      );
    } else {
      rButtons = (
        <Fragment>
          {!hideMicIconInA && (
            <IconButton className="record" onClick={recordSpeech}>
              <Mic />
            </IconButton>
          )}
          {UIVersion !== "A" && this.props.viewLevel === 1 && (
            <IconButton onClick={this.handleEditToggle}>
              <Edit />
            </IconButton>
          )}
          {UIVersion !== "A" && !active && !editing && !respeaking && (
            <IconButton onClick={deleteSpeech}>
              <Delete />
            </IconButton>
          )}
        </Fragment>
      );
    }

    let lButtons = null;
    if (!active && !editing && !respeaking) {
      lButtons = (
        <Fragment>
          {UIVersion === "C" && (
            <Fragment>
              <Checkbox onChange={autoMergeSelect} />
              <IconButton onClick={splitRamble}>
                <ContentCut />
              </IconButton>
              <IconButton onClick={updateSummary}>
                <Autorenew />
              </IconButton>
              <IconButton onClick={openEditWithLLM} disabled={splitWords.length < 5}>
                <AutoFixHigh />
              </IconButton>
            </Fragment>
          )}
        </Fragment>
      );
    }

    if (UIVersion !== "A" && respeaking) {
      controlClass += " disabled";
      lButtons = null;
      rButtons = null;
    }

    return (
      <Draggable draggableId={id} key={id} index={index} isDragDisabled={active || editing}>
        {(provided, snapshot) => {
          let bgcolor = "white";
          if (snapshot.isDragging) {
            bgcolor = "#ECF8FF";
          } else if (snapshot.combineTargetFor !== null) {
            bgcolor = "#F5FFE4";
          }

          return (
            <div
              {...provided.draggableProps}
              ref={provided.innerRef}
              className={className}
              id={id}
              style={{
                ...provided.draggableProps.style,
                backgroundColor: bgcolor,
              }}
            >
              {respeakingContent}
              {textContent}
              <div className={controlClass} {...provided.dragHandleProps}>
                <div className="lButtons">{lButtons}</div>
                <div className="rButtons">{rButtons}</div>
              </div>
            </div>
          );
        }}
      </Draggable>
    );
  }
}

export function Keyword({ active, word, onClick, highlight }) {
  let className = ["rambleWord"];
  if (highlight) className.push("highlightWord");
  if (active) className.push("activeWord");
  return (
    <Fragment>
      <span className={className.join(" ")} onClick={onClick}>
        {word}
      </span>{" "}
    </Fragment>
  );
}

export default RambleBox;
