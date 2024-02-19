# RAMBLER (CHI 2024)

### Supporting Writing With Speech via LLM-Assisted Gist Manipulation

See our paper PDF: https://arxiv.org/abs/2401.10838


### Installation

For frontend (app):

        cd app
        npm install
        npm run start

...and for backend, in a new terminal (server):

        cd server
        npm install
        node server.js


### Secrets

In the project's root directory (`rambler/`), create a new file named `.env`, and fill out the related API keys:
        
```
ASSEMBLYAI_API_KEY=
OPENAI_API_KEY=
LLM_KEY=
```


### Code formatting

        npx prettier . --write

Or in VS Code:

        Format Document With... > Prettier - Code formatter
