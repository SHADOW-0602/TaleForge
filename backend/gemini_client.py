import os
import requests
import json
import base64
import asyncio
import re
from datetime import datetime
from dotenv import load_dotenv
from google import genai
from google.genai.types import GenerateContentConfig, Modality
from google.genai.errors import ClientError
from google.cloud import texttospeech
from google.cloud import storage
import io

load_dotenv()

class GeminiClient:
    def __init__(self):
        self.project = os.getenv("GOOGLE_CLOUD_PROJECT")
        self.location = os.getenv("GOOGLE_CLOUD_LOCATION", "us-central1")
        self.bucket_name = f"taleforge-assets-{self.project}"
        self.miro_token = os.getenv("MIRO_ACCESS_TOKEN")
        self.miro_board_id = os.getenv("MIRO_BOARD_ID")
        
        # Google Gen AI Clients
        self.all_clients = []
        for i in range(1, 6):
            key = os.getenv(f"GEMINI_API_KEY_{i}")
            if key:
                self.all_clients.append(genai.Client(api_key=key))
        
        self.vertex_client = None
        if self.project:
            self.vertex_client = genai.Client(vertexai=True, project=self.project, location=self.location)

        # Native Google Cloud Clients
        self.tts_client = texttospeech.TextToSpeechClient()
        self.storage_client = storage.Client(project=self.project)
        
        # Internal State
        self.speaker_map = {} # Maps character names to Google TTS voice profiles
        # Google TTS Voice Options (Neural2/Studio)
        self.available_voices = {
            "MALE": [
                {"name": "en-US-Neural2-D", "ssml_gender": texttospeech.SsmlVoiceGender.MALE},
                {"name": "en-GB-Neural2-B", "ssml_gender": texttospeech.SsmlVoiceGender.MALE}
            ],
            "FEMALE": [
                {"name": "en-US-Neural2-F", "ssml_gender": texttospeech.SsmlVoiceGender.FEMALE},
                {"name": "en-AU-Neural2-A", "ssml_gender": texttospeech.SsmlVoiceGender.FEMALE}
            ],
            "NEUTRAL": [
                # Default to female narrator, but we could add Journey voices later
                {"name": "en-US-Neural2-F", "ssml_gender": texttospeech.SsmlVoiceGender.FEMALE},
                {"name": "en-US-Neural2-D", "ssml_gender": texttospeech.SsmlVoiceGender.MALE}
            ]
        }

    async def _safe_generate(self, role: str, prompt: str, system_instr: str = None, modalities: list = None, model: str = "gemini-2.0-flash"):
        """
        Asynchronously calls Gemini rotating through ALL available keys on failure.
        """
        # Define the priority list for this specific role
        # We still try to give each role a 'preferred' key, but fallback to everything else
        role_map = {"story": 0, "image": 1, "video": 2, "audio": 3, "fallback": 4}
        pref_idx = role_map.get(role, 0)
        
        # Reorder pool so preferred is first, then the rest cyclically
        clients = []
        if pref_idx < len(self.all_clients):
            clients.append(self.all_clients[pref_idx])
            clients += self.all_clients[pref_idx+1:] + self.all_clients[:pref_idx]
        else:
            clients = self.all_clients
            
        if self.vertex_client:
            clients.append(self.vertex_client)
        
        config = GenerateContentConfig(
            system_instruction=system_instr,
            response_modalities=modalities
        ) if system_instr or modalities else None
        
        for client in clients:
            if not client: continue
            try:
                # Use asychronous (aio) client for performance
                response = await client.aio.models.generate_content(
                    model=model,
                    contents=prompt,
                    config=config
                )
                return response
            except Exception as e:
                err_msg = str(e).upper()
                print(f"Role '{role}' fail/retry on {type(client).__name__} (Model: {model}): {e}")
                
                # If we hit a quota or server error, we MUST move to next key
                # If we hit a quota, server error, or if Vertex doesn't support the specific model name (404), move to next key
                if "429" in err_msg or "RESOURCE_EXHAUSTED" in err_msg or "500" in err_msg or "404" in err_msg or "NOT_FOUND" in err_msg:
                    continue
                # For other errors (like invalid prompt), we might still want to try another key
                # just in case of regional blocks, but mostly we continue.
                continue
        
        return None

    async def _safe_stream_generate(self, role: str, prompt: str, system_instr: str = None, modalities: list = None, model: str = "gemini-2.5-flash"):
        """
        Streaming version of _safe_generate for real-time text delivery.
        """
        role_map = {"story": 0, "image": 1, "video": 2, "audio": 3, "fallback": 4}
        pref_idx = role_map.get(role, 0)
        
        clients = []
        if pref_idx < len(self.all_clients):
            clients.append(self.all_clients[pref_idx])
            clients += self.all_clients[pref_idx+1:] + self.all_clients[:pref_idx]
        else:
            clients = self.all_clients
            
        if self.vertex_client:
            clients.append(self.vertex_client)
        
        config = GenerateContentConfig(
            system_instruction=system_instr,
            response_modalities=modalities
        ) if system_instr or modalities else None
        
        for client in clients:
            if not client: continue
            try:
                # Use generate_content_stream for text-based roles
                async for chunk in await client.aio.models.generate_content_stream(
                    model=model,
                    contents=prompt,
                    config=config
                ):
                    yield chunk
                return # Successful stream
            except Exception as e:
                err_msg = str(e).upper()
                client_id = f"Key_{pref_idx+1}" if "generativelanguage" in str(type(client)) else "VertexAI"
                print(f"Role '{role}' stream fail on {client_id}: {e}")
                
                if "429" in err_msg or "RESOURCE_EXHAUSTED" in err_msg:
                    print(f"Rate limit hit on {client_id}. Rotating to next available key...")
                    await asyncio.sleep(1) # Small pause before retry
                    continue
                if "500" in err_msg:
                    continue
                continue

    def _extract_characters(self, text: str):
        """Simple extraction of characters to assign voices."""
        # Look for capitalized names followed by a colon or in quotes
        found = re.findall(r"([A-Z][a-z]+):", text)
        return list(set(found))

    async def _upload_to_gcs(self, data: bytes, mime_type: str, prefix: str) -> str:
        """Uploads binary data to GCS and returns a public/signed URL."""
        if not self.project: return f"data:{mime_type};base64,{base64.b64encode(data).decode()}"
        
        try:
            bucket = self.storage_client.bucket(self.bucket_name)
            if not bucket.exists():
                bucket = self.storage_client.create_bucket(self.bucket_name, location=self.location)
            
            filename = f"{prefix}_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{os.urandom(4).hex()}"
            ext = mime_type.split("/")[-1]
            blob = bucket.blob(f"narratives/{filename}.{ext}")
            
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(None, lambda: blob.upload_from_string(data, content_type=mime_type))
            
            # Make public for now (or use signed URLs if security required)
            blob.make_public()
            return blob.public_url
        except Exception as e:
            print(f"GCS Upload Error: {e}")
            return f"data:{mime_type};base64,{base64.b64encode(data).decode()}"

    async def _detect_gender(self, char_name: str) -> str:
        """Uses Gemini to rapidly infer the likely gender of a character name."""
        if not char_name or char_name.lower() in ["narrator", "announcer", "voice"]:
            return "NEUTRAL"
            
        prompt = f"What is the most likely gender for the character name '{char_name}'? Answer with exactly one word: MALE, FEMALE, or NEUTRAL."
        try:
            # We use the fastest model for this micro-task
            res = await self._safe_generate("story", prompt, model="gemini-2.5-flash")
            if res and res.text:
                gender = res.text.strip().upper()
                if gender in ["MALE", "FEMALE", "NEUTRAL"]:
                    return gender
        except Exception as e:
            print(f"Gender Detection Error for {char_name}: {e}")
            
        return "NEUTRAL"

    async def _generate_google_tts(self, text: str, char_name: str = None):
        """Generates premium audio using Google Cloud Text-to-Speech."""
        try:
            if char_name:
                if char_name not in self.speaker_map:
                    gender = await self._detect_gender(char_name)
                    voice_list = self.available_voices.get(gender, self.available_voices["NEUTRAL"])
                    
                    # We pick a voice from the gender pool, rotating through them
                    # based on how many characters of that gender we've already mapped
                    mapped_genders = [v for k, v in self.speaker_map.items() if v in voice_list]
                    idx = len(mapped_genders) % len(voice_list)
                    self.speaker_map[char_name] = voice_list[idx]
                
                voice_config = self.speaker_map[char_name]
            else:
                voice_config = self.available_voices["NEUTRAL"][0] # Narrator

            input_text = texttospeech.SynthesisInput(text=text)
            voice = texttospeech.VoiceSelectionParams(
                language_code="en-US",
                name=voice_config["name"],
                ssml_gender=voice_config["ssml_gender"]
            )
            audio_config = texttospeech.AudioConfig(audio_encoding=texttospeech.AudioEncoding.MP3)

            loop = asyncio.get_event_loop()
            response = await loop.run_in_executor(None, lambda: self.tts_client.synthesize_speech(
                request={"input": input_text, "voice": voice, "audio_config": audio_config}
            ))
            
            url = await self._upload_to_gcs(response.audio_content, "audio/mpeg", "narration")
            return {"type": "audio", "content": url}
        except Exception as e:
            print(f"Google TTS Error: {e}")
            return None

    async def _generate_imagen3(self, prompt: str):
        """Generates photorealistic images using Vertex AI Imagen 3."""
        if not self.vertex_client: return None
        try:
            # Note: Imagen 3 model name often depends on region/version
            model_id = "imagen-3.0-generate-001"
            loop = asyncio.get_event_loop()
            response = await loop.run_in_executor(None, lambda: self.vertex_client.models.generate_images(
                model=model_id,
                prompt=prompt,
                config=genai.types.GenerateImagesConfig(number_of_images=1, include_rai_reason=True)
            ))
            
            image_bytes = response.generated_images[0].image.image_bytes
            url = await self._upload_to_gcs(image_bytes, "image/png", "scene")
            return {"type": "image", "content": url}
        except Exception as e:
            print(f"Imagen 3 Error: {e}")
            return None

    async def _generate_veo(self, prompt: str):
        """Generates cinematic motion using Vertex AI Veo with Imagen 3 fallback."""
        if not self.vertex_client: return None
        try:
            # Veo is typically an async long-running operation
            model_id = "veo-001"
            loop = asyncio.get_event_loop()
            
            operation = await loop.run_in_executor(None, lambda: self.vertex_client.models.generate_videos(
                model=model_id,
                prompt=f"Cinematic 4k movie clip: {prompt}. Professional lighting and motion.",
            ))
            
            # Polling for completion with safety delay
            await asyncio.sleep(10) # Give the operation a moment to register
            while not operation.done:
                await asyncio.sleep(10) # 10s intervals for video generation
                operation = await loop.run_in_executor(None, lambda: self.vertex_client.operations.get(operation.name))
            
            video_url = operation.result.generated_videos[0].video.uri
            return {"type": "video", "content": video_url}
        except Exception as e:
            msg = str(e).upper()
            err_type = type(e).__name__
            print(f"Veo Error ({err_type}): {e}")
            # FALLBACK: If Veo is not available (404), restricted, or unsupported by SDK (AttributeError)
            if "NOT_FOUND" in msg or "404" in msg or "PERMISSION_DENIED" in msg or "ATTRIBUTEERROR" in err_type.upper():
                print(f"Falling back to Imagen 3 for cinematic visual ({prompt[:30]}...)")
                return await self._generate_imagen3(prompt)
            return None

    async def _generate_miro_diagram(self, json_str: str):
        """Generates a diagram on Miro via their REST API from a JSON string."""
        if not self.miro_token or not self.miro_board_id:
            print("Miro credentials missing in .env")
            return None
        try:
            # Strip markdown markup if present
            clean_json = json_str.strip()
            if "```json" in clean_json:
                clean_json = clean_json.split("```json")[-1].split("```")[0].strip()
            elif "```" in clean_json:
                clean_json = clean_json.split("```")[-1].split("```")[0].strip()
            
            data = json.loads(clean_json)
            nodes = data.get("nodes", [])
            edges = data.get("edges", [])
            
            headers = {
                "Authorization": f"Bearer {self.miro_token}",
                "Accept": "application/json",
                "Content-Type": "application/json"
            }
            node_map = {}
            # Lay out nodes
            x, y = 0, 0
            for idx, node in enumerate(nodes):
                nid = str(node.get("id", str(idx)))
                content = node.get("content", f"Node {nid}")
                # Simple grid layout: 3 columns
                x = (idx % 3) * 300
                y = (idx // 3) * 200
                payload = {
                    "data": {"content": content, "shape": "rectangle"},
                    "position": {"x": x, "y": y}
                }
                res = requests.post(f"https://api.miro.com/v2/boards/{self.miro_board_id}/shapes", headers=headers, json=payload)
                if res.status_code in (200, 201):
                    node_map[nid] = res.json().get("id")
            
            # Connect them
            for edge in edges:
                start_id = node_map.get(str(edge.get("start")))
                end_id = node_map.get(str(edge.get("end")))
                if start_id and end_id:
                    payload = {"startItem": {"id": start_id}, "endItem": {"id": end_id}}
                    requests.post(f"https://api.miro.com/v2/boards/{self.miro_board_id}/connectors", headers=headers, json=payload)
            
            board_url = f"https://miro.com/app/live-embed/{self.miro_board_id}/?moveToViewport=-318,-303,2674,1362&embedId=602359286660&embedAutoplay=true"
            return {"type": "blueprint", "content": board_url}
        except Exception as e:
            print("Miro Diagram Error:", e)
            return {"type": "info", "content": "Attempted to draw Miro diagram, but encountered an error."}

    async def analyze_keywords(self, keywords: list) -> dict:
        """Analyzes a list of words to understand their semantic meanings."""
        if not keywords: return {}
        
        prompt = f"Analyze the following keywords and provide a concise, evocative definition or theme for each: {', '.join(keywords)}. Format as JSON: {{'word': 'definition'}}."
        res = await self._safe_generate("story", prompt, model="gemini-2.0-flash")
        
        try:
            # Extract JSON from response
            text = res.text.strip()
            if "```json" in text:
                text = text.split("```json")[1].split("```")[0].strip()
            return json.loads(text)
        except Exception as e:
            print(f"Keyword Analysis Error: {e}")
            return {k: "A mysterious and intriguing concept." for k in keywords}

    async def _detect_style(self, prompt: str, keywords: list, mode: str) -> str:
        """Analyzes the prompt and keywords to detect the best cinematic style."""
        # Non-fiction or specialized modes use their own intrinsic style, not a cinematic one.
        if mode != "Storybook":
            return mode
            
        options = ["Cinematic", "Epic Fantasy", "Sci-Fi Noir", "Political Drama", "Space Opera", "Mystery", "Comedy", "Thriller"]
        analysis_prompt = (
            f"Analyze the following story hook and keywords. Select exactly ONE style from this list that best fits the theme: {', '.join(options)}.\n"
            f"Hook: {prompt}\n"
            f"Keywords: {', '.join(keywords) if keywords else 'None'}\n"
            f"Return ONLY the name of the style."
        )
        try:
            res = await self._safe_generate("story", analysis_prompt, model="gemini-2.5-flash")
            detected = res.text.strip() if res else "Cinematic"
            for opt in options:
                if opt.lower() in detected.lower():
                    return opt
        except:
            pass
        return "Cinematic"

    async def generate_storybook_stream(self, prompt: str, mode: str = "Storybook", style: str = "Auto", ai_mode: str = "Auto", duration: str = "Short", keywords: list = None, narration: bool = True):
        """
        Async generator yielding text chunks and then assets (HF Images/Audio).
        """
        duration_map = {
            "Short": "a short story (approx. 5 minutes reading time / 2 A4 pages). Structure it into 3-4 dense scenes.",
            "Medium": "a medium-length story (approx. 30 A4 pages). Structure it into 10-12 detailed chapters with complex character arcs.",
            "Large": "a long-form novel (approx. 100 A4 pages). Structure it into 25-30 expansive chapters with deep world-building and subplots."
        }
        instr_length = duration_map.get(duration, duration_map["Short"])

        # Phase -1: Genre Detection (Director's Intuition)
        active_style = style
        if style == "Auto":
            yield {"type": "info", "content": "Analyzing your vision to select the perfect cinematic style..."}
            active_style = await self._detect_style(prompt, keywords, mode)
            yield {"type": "info", "content": f"Creative Direction set to: **{active_style}**"}

        # Phase 0: Keyword Contextualization
        keyword_context = ""
        if keywords:
            definitions = await self.analyze_keywords(keywords)
            keyword_context = "CRITICAL: The story MUST incorporate the following keywords and their intended meanings:\n"
            for k, d in definitions.items():
                keyword_context += f"- {k}: {d}\n"
            yield {"type": "info", "content": "Keywords analyzed. Weaving them into the narrative..."}
            
            # Auto-prompt generator if user only provided keywords
            if not prompt or not prompt.strip():
                yield {"type": "info", "content": "No main prompt detected. Dreaming up a concept from your keywords..."}
                synth_prompt = (
                    f"Create a highly compelling, 2-sentence main idea/hook for a {mode} based ONLY on these keywords: {', '.join(keywords)}. "
                    f"Make it creative and punchy."
                )
                res = await self._safe_generate("story", synth_prompt, model="gemini-2.5-flash")
                if res and res.text:
                    prompt = res.text.strip()
                    yield {"type": "info", "content": f"**Auto-Generated Concept:** {prompt}"}
                else:
                    prompt = f"A creative exploration involving: {', '.join(keywords)}"

        # Phase 1: Stream Story Text
        if mode == "Storybook":
            story_instr = (
                f"You are a master storyteller in the {active_style} style. "
                f"Write {instr_length} "
                f"{keyword_context}"
                f"Every few scenes/chapters, include exactly one [IMAGE_PROMPT: description] for visual accompaniment. "
                f"Include exactly one [VIDEO_PROMPT: cinematic scene summary] to trigger a motion video asset for the climax or intro. "
                f"Additionally, at the start of each scene or during major atmospheric shifts, include a [MUSIC_STYLE: mood] tag "
                f"(choose from: Suspense, Action, Calm, Mysterious, Epic, Melancholic) to set the narrative score."
            )
        elif mode == "Marketing Campaign":
            story_instr = (
                f"You are an elite marketing copywriter and creative director. "
                f"Write a comprehensive marketing campaign for the following product/concept: "
                f"{keyword_context}"
                f"Structure the output with a catchy headline, compelling body copy, and a clear call-to-action. "
                f"Include exactly one [IMAGE_PROMPT: high-end product photography description] for a hero image. "
                f"Include exactly one [VIDEO_PROMPT: cinematic lifestyle promotional video description] to generate a video asset. "
                f"Include a [MUSIC_STYLE: Epic] tag to set an energetic tone."
            )
        elif mode == "Educational Explainer":
            story_instr = (
                f"You are a world-class educator and instructional designer. "
                f"Create a clear, engaging educational script explaining the following topic: "
                f"{keyword_context}"
                f"Break the concept down into easy-to-understand analogies and step-by-step explanations. "
                f"Include exactly one [MIRO_DIAGRAM] JSON [/MIRO_DIAGRAM] block representing a concept map. "
                f"The JSON must have this strict format: {{\"nodes\": [{{\"id\": \"1\", \"content\": \"Node Text\"}}], \"edges\": [{{\"start\": \"1\", \"end\": \"2\"}}]}}. "
                f"Include a [MUSIC_STYLE: Calm] tag for a focused learning atmosphere."
            )
        elif mode in ["Pitch Deck", "Workflow Planning"]:
            story_instr = (
                f"You are an elite strategic consultant and systems analyst. "
                f"Create a structured breakdown for: {keyword_context} "
                f"Include clear phases or steps in your business report or deck. "
                f"Include exactly one [MIRO_DIAGRAM] JSON [/MIRO_DIAGRAM] block representing the workflow, architecture, or flow chart. "
                f"The JSON must have this strict format: {{\"nodes\": [{{\"id\": \"1\", \"content\": \"Step 1\"}}], \"edges\": [{{\"start\": \"1\", \"end\": \"2\"}}]}}."
            )
        elif mode == "Social Media Post":
            story_instr = (
                f"You are a viral social media manager. "
                f"Create an engaging, highly-shareable social media post (e.g., Instagram/TikTok style) about: "
                f"{keyword_context}"
                f"Include a hook, engaging caption body with line breaks, a CTA, and a block of 5-8 relevant hashtags. "
                f"Include exactly one [IMAGE_PROMPT: striking, vertical-oriented lifestyle or aesthetic photography description] for the feed. "
                f"Include a [MUSIC_STYLE: Action] tag for an upbeat vibe."
            )
        else:
            story_instr = f"Create content about this prompt, incorporating {keyword_context}"
        
        full_text = ""
        text_buffer = ""
        img_pattern = re.compile(r"\[IMAGE_PROMPT:\s*(.*?)\]", re.IGNORECASE)
        vid_pattern = re.compile(r"\[VIDEO_PROMPT:\s*(.*?)\]", re.IGNORECASE)
        music_pattern = re.compile(r"\[MUSIC_STYLE:\s*(.*?)\]", re.IGNORECASE)
        miro_pattern = re.compile(r"\[MIRO_DIAGRAM\]\s*(.*?)\s*\[/MIRO_DIAGRAM\]", re.IGNORECASE | re.DOTALL)
        
        async for chunk in self._safe_stream_generate("story", prompt, system_instr=story_instr, model="gemini-2.0-flash"):
            if chunk.text:
                full_text += chunk.text
                text_buffer += chunk.text
                
                last_open = text_buffer.rfind('[')
                if last_open != -1:
                    last_close = text_buffer.rfind(']', last_open)
                    if last_close == -1:
                        safe_to_yield = text_buffer[:last_open]
                        text_buffer = text_buffer[last_open:]
                    else:
                        if "[MIRO_DIAGRAM]" in text_buffer.upper() and "[/MIRO_DIAGRAM]" not in text_buffer.upper():
                            first_miro = text_buffer.upper().find("[MIRO_DIAGRAM]")
                            safe_to_yield = text_buffer[:first_miro]
                            text_buffer = text_buffer[first_miro:]
                        else:
                            safe_to_yield = text_buffer
                            text_buffer = ""
                else:
                    safe_to_yield = text_buffer
                    text_buffer = ""

                if safe_to_yield:
                    music_matches = music_pattern.findall(safe_to_yield)
                    for mood in music_matches:
                        yield {"type": "music", "content": mood}

                    clean_chunk = safe_to_yield
                    clean_chunk = img_pattern.sub("", clean_chunk)
                    clean_chunk = vid_pattern.sub("", clean_chunk)
                    clean_chunk = music_pattern.sub("", clean_chunk)
                    clean_chunk = miro_pattern.sub("", clean_chunk)
                    
                    if clean_chunk:
                        yield {"type": "text", "content": clean_chunk}
                        
        if text_buffer:
            clean_chunk = text_buffer
            clean_chunk = img_pattern.sub("", clean_chunk)
            clean_chunk = vid_pattern.sub("", clean_chunk)
            clean_chunk = music_pattern.sub("", clean_chunk)
            clean_chunk = miro_pattern.sub("", clean_chunk)
            if clean_chunk:
                yield {"type": "text", "content": clean_chunk}

        if not full_text:
            yield {"type": "error", "content": "Story generation failed or was blocked."}
            return

        # Phase 2: Dispatch Parallel Assets (Vertex AI & Miro)
        img_prompts = img_pattern.findall(full_text)
        vid_prompts = vid_pattern.findall(full_text)
        miro_diagrams = miro_pattern.findall(full_text)
        
        tasks = []
        
        # Miro Diagrams (API)
        for miro_json in miro_diagrams[:1]:
            tasks.append(self._generate_miro_diagram(miro_json))

        # Images (Imagen 3)
        for img_p in img_prompts[:2]:
            prompt_modifier = f"Professional high-quality photography, high resolution: " if mode in ["Marketing Campaign", "Social Media Post"] else f"Cinematic {active_style} style digital art: "
            if mode == "Educational Explainer":
                 prompt_modifier = "Clean, modern educational diagram or infographic style: "
            tasks.append(self._generate_imagen3(f"{prompt_modifier}{img_p}"))
            
        # Audio (Google Cloud TTS & Background Music)
        if narration:
            try:
                # 1. Parse text into dialogue blocks smartly using ultra-fast Flash model
                blocks = []
                
                # Strip tags so they aren't read aloud or parsed as story text
                clean_full_text = full_text
                clean_full_text = img_pattern.sub("", clean_full_text)
                clean_full_text = vid_pattern.sub("", clean_full_text)
                clean_full_text = music_pattern.sub("", clean_full_text)
                clean_full_text = miro_pattern.sub("", clean_full_text)
                
                extraction_prompt = (
                    "ACT AS A CINEMATIC AUDIOBOOK PRODUCER. I want you to transform this story into an engaging, multi-voice audio experience. "
                    "Your task is to review the text and identify EXACTLY what should be narrated to tell the story effectively. "
                    "\n\nRules for narration:\n"
                    "- 1. Identify which lines are descriptive narration (Narrator) and which are character dialogue.\n"
                    "- 2. For dialogue, identify the specific character name (e.g., 'Arthur', 'Luna', 'The Stranger') so we can assign them a unique voice.\n"
                    "- 3. SKIP any system tags like [IMAGE_PROMPT], [MUSIC_STYLE], or [VIDEO_PROMPT] entirely. Do NOT narrate them.\n"
                    "- 4. Ensure the flow feels natural—don't just read line-by-line; group sentences that belong to the same emotional moment into a single block.\n"
                    "- 5. Maintain the original story's impact. Use the 'Narrator' for the prose and the 'Character Name' for their spoken words.\n"
                    "\nReturn a clean JSON array of blocks: [{\"speaker\": \"Voice Name\", \"text\": \"Text to read\"}].\n"
                    f"\nSTORY TO PROCESS:\n{clean_full_text}"
                )
                try:
                    res = await self._safe_generate(
                        "story", 
                        extraction_prompt, 
                        model="gemini-2.5-flash", 
                        system_instr="You are a script parser. Output ONLY a valid JSON array."
                    )
                    blocks_text = res.text.strip()
                    if "```json" in blocks_text:
                        blocks_text = blocks_text.split("```json")[1].split("```")[0].strip()
                    blocks = json.loads(blocks_text)
                except Exception as e:
                    print(f"JSON Parse fallback: {e}")
                    # Fallback to simple paragraph logic if JSON fails
                    paragraphs = [p.strip() for p in re.split(r'\n+', clean_full_text) if p.strip()]
                    blocks = [{"speaker": "Narrator", "text": p} for p in paragraphs]

                # 2. Generate Audio for each block in parallel
                async def generate_block_audio(idx, block):
                     audio_res = await self._generate_google_tts(block["text"], char_name=block["speaker"])
                     
                     # --- Keyword Heuristic Engine (Curated URLs) ---
                     text_lower = block["text"].lower()
                     
                     if any(word in text_lower for word in ["suddenly", "run", "fast", "danger", "gun", "market crash", "loss", "urgent"]):
                         assigned_music = "https://incompetech.com/music/royalty-free/mp3-royaltyfree/Ghost%20Story.mp3" # Tense/Action
                     elif any(word in text_lower for word in ["beautiful", "peace", "calm", "gentle", "welcome", "solution", "easy", "science", "history", "fascinating", "discover", "learn"]):
                         assigned_music = "https://incompetech.com/music/royalty-free/mp3-royaltyfree/Relaxing%20Piano%20Music.mp3" # Calm
                     elif any(word in text_lower for word in ["huge", "massive", "million", "victory", "epic", "battle", "world", "revenue", "growth", "metrics", "startup", "investors"]):
                         assigned_music = "https://incompetech.com/music/royalty-free/mp3-royaltyfree/Epic%20Unease.mp3" # Epic
                     elif any(word in text_lower for word in ["mystery", "secret", "hidden", "dark", "unknown", "discover"]):
                         assigned_music = "https://incompetech.com/music/royalty-free/mp3-royaltyfree/Gagool.mp3" # Mysterious
                     else:
                         assigned_music = None
                         
                     if audio_res and audio_res.get("content"):
                         return {
                             "index": idx,
                             "speaker": block["speaker"],
                             "text": block["text"],
                             "audio_url": audio_res["content"],
                             "music_url": assigned_music
                         }
                     return None

                # Generate in batches of 10 to avoid overwhelming Google TTS concurrent limits
                async def compile_narration():
                    batch_size = 10
                    valid_blocks = []
                    
                    for i in range(0, len(blocks), batch_size):
                        batch = blocks[i:i + batch_size]
                        tts_tasks = [generate_block_audio(i + j, b) for j, b in enumerate(batch)]
                        results = await asyncio.gather(*tts_tasks)
                        valid_blocks.extend([r for r in results if r is not None])
                        
                    # Sort by index to maintain story order
                    valid_blocks.sort(key=lambda x: x["index"])
                    
                    # Simulated Lyria background track based on style
                    bg_music = "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3"
                    if active_style == "Calm" or mode == "Educational Explainer":
                        bg_music = "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-8.mp3"
                    elif mode in ["Pitch Deck", "Workflow Planning", "Marketing Campaign"]:
                         bg_music = "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-9.mp3"
                         
                    return {
                        "type": "narration_track", 
                        "blocks": valid_blocks,
                        "background_music": bg_music
                    }
                
                tasks.append(compile_narration())
                
            except Exception as e:
                print(f"Failed to generate narration sequence: {e}")

        # Video (Veo)
        for vid_p in vid_prompts[:1]:
            tasks.append(self._generate_veo(vid_p))
        if not vid_prompts and mode == "Storybook" and img_prompts:
            tasks.append(self._generate_veo(img_prompts[0]))

        # Yield assets as they finish
        for task in asyncio.as_completed(tasks):
            res = await task
            if res:
                yield res

    async def generate_surprise_prompt(self, style: str = "Cinematic", ai_mode: str = "Auto", mode: str = "Storybook") -> str:
        import random
        # High-entropy seeds to force the LLM out of deterministic ruts
        seeds = ["cyberpunk", "ancient", "whimsical", "dreadful", "utopian", "bizarre", "minimalist", "maximalist", "nostalgic", "futuristic", "satirical", "gothic", "neon", "rustic", "alien", "cozy", "gritty"]
        seed = random.choice(seeds)
        
        prompt_map = {
            "Storybook": f"One unique, entirely original story hook for {style} with a very {seed} undertone.",
            "Marketing Campaign": f"A brand new, wildly disruptive product idea to market that feels very {seed}.",
            "Educational Explainer": f"A fascinating, highly complex scientific or historical topic to explain, perhaps related to something {seed}.",
            "Pitch Deck": f"An innovative, entirely out-of-the-box startup business idea to pitch investors that has a {seed} aesthetic.",
            "Workflow Planning": f"A complex but common business process diagram to plan, specifically for a {seed} industry.",
            "Social Media Post": f"A trending, highly controversial, or hyper-engaging topic for social media appealing to a {seed} demographic.",
        }
        topic = prompt_map.get(mode, f"One radically unique idea for {mode}.")
        
        system_instructions = "You are a highly creative prompt engineer. Generate ONLY the raw text for the user's prompt. Do NOT include quotes, prefixes, or explanations. Ensure the output is wildly imaginative and never repeats previous generic ideas."
        
        res = await self._safe_generate("story", f"{topic} Keep it to 1 sentence, maximum 2.", system_instr=system_instructions, model="gemini-2.5-flash")
        
        return res.text.strip().strip('"').strip("'") if res else "A mysterious figure appears in the fog."

    async def continue_storybook_stream(self, new_prompt: str, existing_context: str, mode: str = "Storybook", style: str = "Auto", duration: str = "Short", keywords: list = None):
        """
        Async generator for continuing a story given existing text context.
        """
        duration_map = {
            "Short": "a short follow-up scene (1-2 paragraphs).",
            "Medium": "a medium-length continuation (3-5 paragraphs) advancing the plot.",
            "Large": "a long, highly detailed chapter exploring this new prompt deeply."
        }
        instr_length = duration_map.get(duration, duration_map["Short"])

        keyword_context = ""
        if keywords:
            definitions = await self.analyze_keywords(keywords)
            keyword_context = "Incorporate these new keywords organically:\n"
            for k, d in definitions.items():
                keyword_context += f"- {k}: {d}\n"
                
        # System instructions to ground the AI in the past context
        system_instr = (
            f"You are a master storyteller in the {style} style continuing an ongoing narrative.\n"
            f"Here is the story so far:\n\n---\n{existing_context[-4000:]}\n---\n\n" # Send last 4000 chars as context window
            f"INSTRUCTIONS:\n"
            f"Write {instr_length} based on the user's prompt to continue the story naturally. "
            f"Do NOT repeat the existing story. Pick up exactly where it left off or introduce the prompt seamlessly.\n"
            f"{keyword_context}"
            f"Include exactly one [IMAGE_PROMPT: description] for visual accompaniment of this new scene. "
            f"Include a [MUSIC_STYLE: mood] tag (choose from: Suspense, Action, Calm, Mysterious, Epic, Melancholic)."
        )
        
        full_text = ""
        text_buffer = ""
        img_pattern = re.compile(r"\[IMAGE_PROMPT:\s*(.*?)\]", re.IGNORECASE)
        music_pattern = re.compile(r"\[MUSIC_STYLE:\s*(.*?)\]", re.IGNORECASE)
        
        async for chunk in self._safe_stream_generate("story", new_prompt, system_instr=system_instr, model="gemini-2.0-flash"):
            if chunk.text:
                full_text += chunk.text
                text_buffer += chunk.text
                
                last_open = text_buffer.rfind('[')
                if last_open != -1:
                    last_close = text_buffer.rfind(']', last_open)
                    if last_close == -1:
                        safe_to_yield = text_buffer[:last_open]
                        text_buffer = text_buffer[last_open:]
                    else:
                        safe_to_yield = text_buffer
                        text_buffer = ""
                else:
                    safe_to_yield = text_buffer
                    text_buffer = ""

                if safe_to_yield:
                    music_matches = music_pattern.findall(safe_to_yield)
                    for mood in music_matches:
                        yield {"type": "music", "content": mood}

                    clean_chunk = safe_to_yield
                    clean_chunk = img_pattern.sub("", clean_chunk)
                    clean_chunk = music_pattern.sub("", clean_chunk)
                    
                    if clean_chunk:
                        yield {"type": "text", "content": clean_chunk}
                        
        if text_buffer:
            clean_chunk = text_buffer
            clean_chunk = img_pattern.sub("", clean_chunk)
            clean_chunk = music_pattern.sub("", clean_chunk)
            if clean_chunk:
                yield {"type": "text", "content": clean_chunk}

        if not full_text:
            yield {"type": "error", "content": "Continuation failed."}
            return

        # Parallel Assets specifically for the continuation
        img_prompts = img_pattern.findall(full_text)
        tasks = []
        for img_p in img_prompts[:1]: # Max 1 image per continuation to save time/cost
            tasks.append(self._generate_imagen3(img_p))

        # Yield assets as they finish
        for task in asyncio.as_completed(tasks):
            res = await task
            if res:
                yield res
