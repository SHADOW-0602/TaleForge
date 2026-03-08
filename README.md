# TaleForge 🎬✨

TaleForge is an advanced, AI-powered multimodal creative engine that acts as your personal **Creative Director & Analyst**. It generates immersive, mixed-media narratives, workflows, marketing assets, and diagrams as a real-time, fluid stream.

Powered by the **Google Genesis-Stack** (Vertex AI Native) and the **Miro REST API**, TaleForge identifies your vision and brings it to life with professional-grade content and diagrams.

---

## 🌟 Generation Modes

TaleForge supports specialized modes to tailor prompt engineering and asset generation to your specific needs:
- **📖 Storybook**: Narrative storytelling with cinematic art and background elements.
- **📈 Marketing Campaign**: Elite ad copy, hero product photography, and promotional lifestyle videos.
- **🎓 Educational Explainer**: Instructional analogies and step-by-step explanations paired with concept maps drawn on Miro.
- **📊 Pitch Deck**: Business architecture and value chain workflows plotted live to Miro.
- **⚙️ Workflow Planning**: Standardized flowcharts, drawn dynamically on Miro grids with connectors.
- **📱 Social Media Post**: Viral hooks, vertical aesthetic photography, and hashtags optimized for feed engagement.

---

## 🌌 Multimodal Narrative Engine

Experience structured content as it unfolds with interleaved assets:
- **Vertex AI Imagen 3**: Photorealistic scene art and high-end imagery.
- **Vertex AI Veo**: High-fidelity cinematic motion clips woven into key story beats.
- **Miro API**: Live JSON-driven diagram generation (Shapes, Sticky Notes, and Connectors) for educational/business workflows.
- **Google Cloud TTS**: High-end **Neural2/Studio** voices for expressive narration and multi-character acting.
- **Dynamic Score**: A real-time orchestral score that shifts moods based on scene context.

---

## 🏗️ Technical Architecture

- **Backend**: Python (FastAPI), Google Gen AI SDK, Miro API (`requests`).
- **Frontend**: React (Vite) + TypeScript + Vanilla CSS.
- **GenAI Suite**: Gemini 2.0 Flash / 2.0 Pro.
- **Vision**: Vertex AI Imagen 3 (Images) & Veo (Video).
- **Audio**: Google Cloud Text-to-Speech (Narration).
- **Persistence**: Google Cloud Storage (GCS) for asset delivery.

---

## 🚀 Getting Started

### 1. Prerequisites
- Python 3.10+
- Node.js 18+
- Google Cloud Project with Vertex AI and GCS enabled.
- (Optional) Miro Developer App for Workflow Planning diagrams.

### 2. Environment Configuration
Create a `.env` file in the root directory (or `backend/`):
```env
GOOGLE_CLOUD_PROJECT=your-project-id
GOOGLE_CLOUD_LOCATION=us-central1
GEMINI_API_KEY_1=your-api-key
MIRO_ACCESS_TOKEN=your-miro-developer-token
MIRO_BOARD_ID=target-board-id
# Add up to GEMINI_API_KEY_5 for high-availability rotation
```

### 3. Backend Setup
```powershell
cd backend
pip install -r requirements.txt
python -m uvicorn main:app --reload
```

### 4. Frontend Setup
```powershell
cd frontend
npm install
npm run dev
```

### 5. Google Cloud Authentication
Ensure your local environment is authenticated to access Vertex AI:
```powershell
gcloud auth login
gcloud auth application-default login
gcloud config set project your-project-id
```

---

## 🎭 Usage
1. Open TaleForge in your browser (`http://localhost:5173/`).
2. Select your **Generation Mode** (e.g., Workflow Planning, Marketing Campaign).
3. Enter your prompt or use the **"Surprise Me"** button.
4. Add **Keywords** to ground the AI's creative direction.
5. Click **Forge Story** and watch your vision turn into structured multimedia.

---

Built with ❤️ by the **SHADOW**.
