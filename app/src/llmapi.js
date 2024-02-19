import rake from "rake-js";

let llmkey = null;

fetch("/api/frontend-key")
  .then((response) => response.json())
  .then((data) => {
    llmkey = data.key; // Store the frontend key for later use
  })
  .catch((error) => {
    console.error("Error fetching frontend key:", error);
  });

function summaryPrompt(level, keywords, textLength) {
  if (level === 1) {
    return `You are a text cleaning bot that cleans up the text the user enters by correcting obviously incorrect punctuation and formatting, but otherwise keeping the user's text the exact same. You never ask your own questions. For example, if the user enters
    
    Google. Followed by the neural style transfer method, which became really popular. In a lot of cell phone apps. And these things started to. Show up in art galleries and art exhibitions. And more and more artists start playing with it. And now there's a number of fairly. Um, significant contemporary artists who are also playing, experimented with AI techniques. This work all comes out of the, the academic research literature, and whatnot. So these are images from one academic paper which has really 
     
    you should return:  
    
    Google. Followed by the neural style transfer method, which became really popular in a lot of cell phone apps. And these things started to show up in art galleries and art exhibitions and more and more artists start playing with it. And now there's a number of fairly, um, significant contemporary artists who are also playing, experimented with AI techniques. This work all comes out of the, the academic research literature, and whatnot. So these are images from one academic paper which has really`;
  }
  const levelText = {
    4: "5 words or less",
    3: `${Math.round(textLength / 4)} words or less`,
    2: `${Math.round(textLength / 2)} words or less`,
  };
  return `You are a professional writer specializing in text summarization. Make a summary of ${
    levelText[level]
  } of the chunk of the text provided by the user. The summary should reflect the main idea and the most important relationships of the text. You must preserve the same point of view, grammar and tense as the original text. If the text is in the first person, using words like I, you must use the first person as well. If the tone was conversational, you must be human conversational as well. You should use the following keywords to help you determine what to focus the summary on. Ensure that each keyword is in the summary. Try to fit as many as makes sense. Do not include anything else in the response other than the summary.
  
    The keywords are: ${Array.from(keywords).join(" ") || "(no known keywords)"}`;
}

function mergeParagraphs(paragraphs, keywords = []) {
  return `You are a paragraph merger bot, capable of merging paragraphs.
Please merge the following text into one paragraph of roughly median length as the originals:\n\n${paragraphs.join(
    "\n\n"
  )}

  You may use the following keywords to help you merge the text. Ensure that each keyword is in the merged paragraph.

  The keywords are: ${Array.from(keywords).join(" ") || "(no known keywords)"}

  Again, the resulting paragraph should be roughly the average length of the original paragraphs.
  `;
}

function splitSystemPrompt(keywords = []) {
  return `Split the paragraph the user enters into logical, cohesive paragraphs and return the result as a JSON array. Analyze the content and break it up into at least two separate paragraphs (but more where it makes sense). Try to split it into the appropriate number of paragraphs based on the content. Add each paragraph as a separate string element in the JSON array.

  You may use the following keywords to help you split the text. Ensure that each keyword is in its own paragraph.

  The keywords are: ${keywords.join(", ")}`;
}

function segmentSystemPrompt() {
  return `Split the paragraph the user enters into logical, cohesive paragraphs and return the result as a JSON array. Analyze the content and break it up into at least two separate paragraphs (but more where it makes sense). Try to split it into the appropriate number of paragraphs based on the content. Add each paragraph as a separate string element in the JSON array.

Response format:

["Paragraph 1 text", "Paragraph 2 text", "Paragraph 3 text"]
`;
}

function expandParagraphPrompt(keywords, outputLength) {
  return `You are a professional writer specializing in text expansion. 
  Make a expansion of ${outputLength} words of the chunk of the text provided by the user. The expansion should reflect the main idea and the most important relationships of the text. Notice that the user has annotated the text with entities. Each entity is annotated with a unique id in the format of [Artificial Intelligence ($1)]. When expanding the text, annotate the expansion with a consistent style for the entities. Please only use the entity ids that are mentioned in the original text, and match the ids in the original text and expansion if they are the same entity. We will give you a list of keywords that you must use in your expansion, and you must preserve the same format of brackets, words, and ids. You can arrange the sentences in the expansion in a way that facilitates the annotation of entities, but the arrangement should not alter their meaning and they should still flow naturally in language. You may also add additional entities in newly generated text, so long as their IDs do not replace those of the entities that already exist. Try to fit as many as makes sense. Do not include anything else in the response other than the annotated, expanded text. Again, only ${outputLength} words.`;
}

// format
function formatParagraphPrompt(keywords) {
  return `Please provide a well-structured formatting to the user’s paragraph. The new paragraphs should highlight the most important aspects and keywords of the answers. The user’s goal is to construct a concept map to visually explain your response. To achieve this, annotate the key noun phrases, called entities,  inline for each sentence in the paragraphs. 

Entities are single words associated around important noun phrases and should be annotated with [entity ($1)], for example, [Food ($1)]. Do not annotate conjunctive adverbs, such as “since then” or “therefore”, as entities in the map. It is fine to have multiple words in sequence as entities if they are part of a noun phrase, such as “machine learning”, but make sure that each word is annotated separately, for example, [machine ($1)] [learning ($2)]. You should not annotate stop words, such as “the” or “a”, as entities. You should also not annotate words that are not part of the original text.
  
Example paragraph A: 
[Artificial ($1)] [intelligence ($2)] is a [field ($3)] of [computer ($4)] [science ($5)] that [creates ($6)] [intelligent ($7)] [machines ($8)].
  
Your response should be otherwise the same as the original. You must preserve the original words, grammar, sentences in your response, even if the formatting of the text is not perfect in grammar, but you may add new words and rearrange punctuation to make the text more fluent. If you rewrite complete sentences that area already fluent, you die.

The list of already-known keywords is: ${Array.from(keywords).join(" ") || "(no known keywords)"}`;
}

const api = {
  // "pipeline" a function here so that we can call it a bunch of times
  // with new inputs that overwrite any pending inputs, and any time we get
  // data back from the function call, we pass it to the callback.
  //
  // example:
  //   let fastSummaryPipeline = llmapi.pipeline(
  //                               llmapi.fastSummaryAtLevel,
  //                               (r) => setState({ summary: r })
  //                             )
  // ...and later, in some other function that runs when the transcript
  //   fastSummaryPipeline(currentRecordingMessage, currentViewLevel);
  pipeline: (f, cb) => {
    let next = null;
    let active = false;
    return async (...args) => {
      next = args;
      if (!active) {
        do {
          active = true;
          args = next;
          next = null;
          const response = await f(...args);
          active = false;
          cb(response);
        } while (next);
      }
    };
  },

  extractKeywords: (text) => {
    function splitStringWithRegex(input) {
      if (!input) {
        return [];
      }
      const regex = /(\[[^\]]+\s*\(\$\d+\)\])/g;
      const splitArr = input.split(regex).filter(Boolean);
      return splitArr;
    }

    // Input: [rice dish ($4)]
    // Output: 4
    function extractNumbersFromBracket(str) {
      const regex = /\[[^\]]+\s*\(\$(\d+)\)]/g;
      const match = regex.exec(str);
      return match ? parseInt(match[1]) : null;
    }

    // Input: [rice dish ($4)]
    // Output: rice dish
    function extractTextInKeyword(str) {
      const regex = /\[([^\]]+)\s*\(\$\d+\)]/g;
      const match = regex.exec(str);
      return match ? match[1].trim() : null;
    }

    const keywords = splitStringWithRegex(text).map((word) => {
      const wordID = extractNumbersFromBracket(word);
      const wordText = extractTextInKeyword(word);
      return { id: wordID, text: wordText };
    });

    return new Set(keywords.map((k) => k.text));
  },

  callLlmQuery: async (prompt, text, model = "gpt-4", max_tokens = 4000, temperature = 0) => {
    if (isTextUnderWordCount(text)) {
      return text ? text : "";
    }

    const response = await fetch("/api/llm-query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        llmkey,
      },
      body: JSON.stringify({
        messages: [
          {
            role: `system`,
            content: prompt,
          },
          {
            role: `user`,
            content: text,
          },
        ],
        model,
        max_tokens,
        temperature,
      }),
    }).then((response) => response.json());
    return response?.data?.choices[0]?.message?.content;
  },

  callStreamingResponseForLlmQuery: async (
    prompt,
    text,
    {
      model = "gpt-4",
      rambleBoxId = -1,
      max_tokens = 1000,
      temperature = 0,
      level = -1,
      replace = true,
    }
  ) => {
    if (isTextUnderWordCount(text)) {
      return text ? { data: text } : { data: "" };
    }
    const response = await fetch("/api/llm-query-streaming", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        llmkey,
      },
      body: JSON.stringify({
        messages: [
          {
            role: `system`,
            content: prompt,
          },
          {
            role: `user`,
            content: text,
          },
        ],
        model,
        max_tokens,
        temperature,
        rambleBoxId,
        level,
        replace,
      }),
    }).then((response) => response.json());
    console.log(response);
    return response;
  },

  postStreamingResponseForSummary: (
    completeText,
    level,
    keywords = new Set(),
    model = "gpt-4",
    rambleBoxId = -1,
    replace = true
  ) => {
    return api.callStreamingResponseForLlmQuery(
      summaryPrompt(level, keywords, completeText.split(" ").length),
      completeText,
      {
        model,
        rambleBoxId,
        level,
        replace,
      }
    );
  },
  // fastSummaryAtLevel: async (text, level, model = "gpt-3.5-turbo") => {
  //   return (await api.multiLevelSummary(text, [level], model))[0];
  // },

  // fastMultiLevelSummary: async (text, priorSummaries = null, newText = null, keywords = [], model = "gpt-3.5-turbo") => {
  //   return await api.multiLevelSummary(text, levels, keywords, model);
  // },
  multiLevelSummary: async (
    completeText,
    levels = [1, 2, 3, 4],
    keywords = new Set(),
    model = "gpt-4"
  ) => {
    const autoKeywords = rake(completeText, { language: "english" });

    const responses = await Promise.all(
      levels.map((level) =>
        api.callLlmQuery(
          summaryPrompt(level, keywords, completeText.split(" ").length),
          completeText,
          model
        )
      )
    );
    console.log("got summaries", responses);
    return { summaries: responses, autoKeywords };
  },

  mergeText: async (paragraphs, keywords = []) => {
    const response = await fetch("/api/llm-query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        llmkey,
      },
      body: JSON.stringify({
        messages: [
          {
            role: `system`,
            content: mergeParagraphs(paragraphs, keywords),
          },
        ],
        model: "gpt-4",
        max_tokens: 4000,
      }),
    }).then((response) => response.json());
    // console.log(response);
    const mergedParagraph = response?.data?.choices[0]?.message?.content;
    // console.log(mergedParagraph);
    return mergedParagraph;
  },

  splitText: async (paragraph, keywords = []) => {
    const response = await fetch("/api/llm-query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        llmkey,
      },
      body: JSON.stringify({
        messages: [
          {
            role: `system`,
            content: splitSystemPrompt(keywords),
          },
          {
            role: `user`,
            content: paragraph,
          },
        ],
        model: "gpt-4",
        max_tokens: 4000,
      }),
    }).then((response) => response.json()); // We should catch errors as well.
    // console.log(response);
    const splittedParagraph = response?.data?.choices[0]?.message?.content;
    // console.log(mergedParagraph);
    return splittedParagraph;
  },
  formatText: async (paragraph) => {
    const response = await fetch("/api/llm-query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        llmkey,
      },
      body: JSON.stringify({
        messages: [
          {
            role: `system`,
            content: formatParagraphPrompt(),
          },
          {
            role: `user`,
            content: paragraph,
          },
        ],
        model: "gpt-4",
        max_tokens: 2000,
      }),
    }).then((response) => response.json());
    // console.log(response);
    const formattedParagraph = response?.data?.choices[0]?.message?.content;
    // console.log(mergedParagraph);
    return formattedParagraph;
  },

  segmentText: async (paragraph) => {
    const response = await fetch("/api/llm-query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        llmkey,
      },
      body: JSON.stringify({
        messages: [
          {
            role: `system`,
            content: segmentSystemPrompt(),
          },
          {
            role: `user`,
            content: paragraph,
          },
        ],
        model: "gpt-4",
        max_tokens: 4000,
      }),
    }).then((response) => response.json()); // We should catch errors as well.
    console.log(response);
    const segmentedText = response?.data?.choices[0]?.message?.content;
    console.log(segmentedText);
    return segmentedText;
  },

  expandText: async (paragraph, outputLength, keywords = []) => {
    const response = await fetch("/api/llm-query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        llmkey,
      },
      body: JSON.stringify({
        messages: [
          {
            role: `system`,
            content: expandParagraphPrompt(keywords, outputLength),
          },
          {
            role: `user`,
            content: paragraph,
          },
        ],
        model: "gpt-4",
        max_tokens: 4000,
      }),
    }).then((response) => response.json());
    const expandedParagraph = response?.data?.choices[0]?.message?.content;
    return expandedParagraph;
  },
};

export default api;

function isTextUnderWordCount(text, wordCount = 5) {
  if (!text) text = "";
  return text.split(" ").length <= wordCount;
}
