import { v4 as uuidv4 } from "uuid";
import { saveAs } from "file-saver";

export const resetSessionId = () => {
  let sessionId = uuidv4();
  localStorage.setItem("sessionId", sessionId);
  return sessionId;
};

export const downloadContent = ({ filename, content }) => {
  // Infer the file type from the extension
  const ext = filename.split(".").pop();
  let type = "text/plain;charset=utf-8";
  if (ext === "json") {
    type = "application/json;charset=utf-8";
  }

  let blob = new Blob([content], { type });
  saveAs(blob, filename);
};

export const splitTextOnIndex = (text, splitIndex) => {
  const firstHalf = text.slice(0, splitIndex);
  const secondHalf = text.slice(splitIndex);
  return [firstHalf, secondHalf];
};
