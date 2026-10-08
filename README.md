# fqmg-ohz — Prompt to Motion Graphics

AI-powered motion graphics generator built with **Remotion** + **Next.js**.

---

## Features

- 🎬 Text-to-video generation from natural language prompts
- 🧠 OpenAI integration (GPT-based prompt understanding)
- ☁️ AWS Lambda rendering via Remotion Lambda
- ⚡ Live preview in browser (Next.js 16 + Turbopack)
- 🎨 Ready-made components: Typewriter / Chat / Metric Counters / Bar Chart

---

## Requirements

- Node.js >= 18
- npm >= 9
- Git

---

## Installation

```bash
git clone https://github.com/USERNAME/fqmg-ohz.git
cd fqmg-ohz
npm install
```

---

## Configuration

Create `.env.local` in the project root:

```env
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxx
REMOTION_AWS_ACCESS_KEY_ID=
REMOTION_AWS_SECRET_ACCESS_KEY=
```

> WARNING: Never commit `.env.local` — it is already ignored by `.gitignore`.

---

## Development

```bash
npm run dev
```

Open: http://localhost:3000

---

## Rendering

Local:

```bash
npx remotion render
```

Cloud (Remotion Lambda):

```bash
npx remotion lambda render
```

---

## Project Structure

```
fqmg-ohz/
├── src/app/          # Next.js App Router
├── src/components/   # UI components
├── public/           # Static assets
├── styles/           # Global styles
├── .agents/          # Agent Skills
├── remotion.config.ts
└── package.json
```

---

## License

MIT
