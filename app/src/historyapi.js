import { resetSessionId } from "./utils";

const api = {
  // generate session id, stable for duration of session
  sessionId: localStorage.getItem("sessionId") || resetSessionId(),
  resetSessionId: () => (api.sessionId = resetSessionId()),

  context: {},

  // add a new entry to the history
  save: async function (type, action, opData, time = Date.now(), context = api.context) {
    const data = {
      type: type,
      action: action,
      data: opData,
      time: time,
      sessionId: api.sessionId,
      ...context,
    };
    console.log("save", data);
    let response = await fetch("/api/history", {
      method: "POST",
      body: JSON.stringify(data),
      headers: {
        "Content-Type": "application/json",
      },
    });
    let status = await response.json();
    return status;
  },
};

export default api;
