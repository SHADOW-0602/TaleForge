import os
import requests
import json
import base64
import asyncio
import re
import uuid
from datetime import datetime
from dotenv import load_dotenv
from google import genai
from google.genai import types
from google.genai.errors import ClientError
from google.cloud import texttospeech
from google.cloud import storage
import io
from PIL import Image

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
        # Optional Vertex AI fallback client
        self.vertex_client = None
        if self.project and self.location:
            try:
                vertex_token = os.environ.get("VERTEX_API_KEY", "")
                http_opts = {'headers': {'Authorization': f'Bearer {vertex_token}'}} if vertex_token else None
                self.vertex_client = genai.Client(
                    vertexai=True,
                    project=self.project,
                    location=self.location,
                    http_options=http_opts
                )
                print(f"Vertex AI Client initialized in {self.location}")
            except Exception as e:
                print(f"Failed to initialize Vertex AI Client: {e}")

        # Native Google Cloud Clients
        self.tts_client = texttospeech.TextToSpeechClient()
        self.storage_client = storage.Client(project=self.project)
        self.genai_types = types
        
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
        role_map = {"story": 0, "image": 1, "video": 2, "audio": 3, "fallback": 4}
        pref_idx = role_map.get(role, 0)
        
        clients = []
        if pref_idx < len(self.all_clients):
            clients.append(self.all_clients[pref_idx])
            clients += self.all_clients[pref_idx+1:] + self.all_clients[:pref_idx]
        else:
            clients = self.all_clients
            
        if self.vertex_client:
            if role in ["video"]:
                 clients = [self.vertex_client] + clients # Vertex first for specialized models
            else:
                 clients.append(self.vertex_client)
        
        config = types.GenerateContentConfig(
            system_instruction=system_instr,
            response_modalities=modalities
        ) if system_instr or modalities else None
        
        for client in clients:
            if not client: continue
            try:
                # Specific model overrides for Vertex AI if needed
                active_model = model
                is_vertex = getattr(client, 'vertexai', False)
                if is_vertex:
                    # Map standard names to Vertex-specific names
                    vertex_mapping = {
                        "gemini-1.5-flash": "gemini-2.0-flash-001",
                        "gemini-1.5-pro": "gemini-2.5-pro",
                        "gemini-2.0-flash": "gemini-2.0-flash-001",
                        "veo-001": "veo-3.1-generate-001"
                    }
                    mapped_model = vertex_mapping.get(model, model)
                    if "publishers/google/models/" not in mapped_model:
                        active_model = f"publishers/google/models/{mapped_model}"
                    else:
                        active_model = mapped_model

                response = await client.aio.models.generate_content(
                    model=active_model,
                    contents=prompt,
                    config=config
                )
                return response
            except Exception as e:
                err_msg = str(e).upper()
                print(f"Role '{role}' fail/retry on {type(client).__name__} (Vertex={is_vertex}, Model={active_model}): {e}")
                
                if "429" in err_msg or "RESOURCE_EXHAUSTED" in err_msg or "500" in err_msg or "404" in err_msg or "NOT_FOUND" in err_msg:
                    continue
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
            if role in ["video"]:
                 clients = [self.vertex_client] + clients # Vertex first for specialized models
            else:
                 clients.append(self.vertex_client)
        
        config = types.GenerateContentConfig(
            system_instruction=system_instr,
            response_modalities=modalities
        ) if system_instr or modalities else None
        
        for client in clients:
            if not client: continue
            try:
                # Specific model overrides for Vertex AI if needed
                active_model = model
                is_vertex = getattr(client, 'vertexai', False)
                if is_vertex:
                    # Map standard names to Vertex-specific names
                    vertex_mapping = {
                        "gemini-1.5-flash": "gemini-2.0-flash-001",
                        "gemini-1.5-pro": "gemini-2.5-pro",
                        "gemini-2.0-flash": "gemini-2.0-flash-001",
                        "gemini-2.5-flash": "gemini-2.5-flash"
                    }
                    mapped_model = vertex_mapping.get(model, model)
                    if "publishers/google/models/" not in mapped_model:
                        active_model = f"publishers/google/models/{mapped_model}"
                    else:
                        active_model = mapped_model

                async for chunk in await client.aio.models.generate_content_stream(
                    model=active_model,
                    contents=prompt,
                    config=config
                ):
                    yield chunk
                return # Successful stream
            except Exception as e:
                err_msg = str(e).upper()
                print(f"Role '{role}' stream fail: {e}")
                
                if "429" in err_msg or "RESOURCE_EXHAUSTED" in err_msg or "500" in err_msg:
                    continue
                continue

    def _extract_characters(self, text: str):
        """Simple extraction of characters to assign voices."""
        found = re.findall(r"([A-Z][a-z]+):", text)
        return list(set(found))

    async def _upload_to_gcs(self, data: bytes, content_type: str, prefix: str = "asset"):
        """Uploads binary data to GCS and returns a public URL."""
        extension = content_type.split('/')[-1]
        if extension == 'mpeg':
            extension = 'mp3'
            
        filename = f"{prefix}_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}.{extension}"
        bucket = self.storage_client.bucket(self.bucket_name)
        blob = bucket.blob(filename)
        
        # Ensure bucket exists
        if not bucket.exists():
            bucket.create(location=self.location)
            
        # Using predefined_acl='publicRead' ensures the object is public immediately
        blob.upload_from_string(data, content_type=content_type, predefined_acl='publicRead')
        
        # We still keep the make_public() call as a secondary safety measure or if bucket settings differ
        try:
            blob.make_public()
        except Exception as e:
            print(f"Warning: Could not make GCS blob public: {e}")
            
        return blob.public_url

    async def analyze_keywords(self, keywords: list) -> dict:
        """Uses Gemini to explain/expand upon provided prompt keywords."""
        prompt = f"Given these keywords: {', '.join(keywords)}, provide a 1-sentence creative definition/context for EACH that can be used to enrich a story. Return as a clean JSON map."
        res = await self._safe_generate("story", prompt, model="gemini-2.0-flash", system_instr="Output ONLY a valid JSON map.")
        if res and res.text:
            try:
                text = res.text.strip()
                if "```json" in text: text = text.split("```json")[1].split("```")[0].strip()
                return json.loads(text)
            except: return {k: "A mysterious element." for k in keywords}
        return {k: "A mysterious element." for k in keywords}

    async def _detect_style(self, prompt: str, keywords: list, mode: str) -> str:
        """Automagically detect the best cinematic style based on user context."""
        context = f"Prompt: {prompt}\nKeywords: {keywords}\nMode: {mode}"
        instr = "Choose the best cinematic visual style from: Neo-Noir, Ghibli-esque, Hyper-Realistic, Cyberpunk, Watercolor, Gothic, Pixar-like, Retro-Futuristic. Return ONLY the style name."
        res = await self._safe_generate("story", context, model="gemini-2.0-flash", system_instr=instr)
        return res.text.strip() if res else "Cinematic"

    async def _generate_google_tts(self, text: str, char_name: str = "Narrator"):
        """Generates high-quality narration split into blocks for synced playback."""
        try:
            # Persistent voice mapping for character consistency
            if char_name not in self.speaker_map:
                if char_name == "Narrator":
                    self.speaker_map[char_name] = self.available_voices["NEUTRAL"][0]
                else:
                    import random
                    voice_type = random.choice(["MALE", "FEMALE"])
                    self.speaker_map[char_name] = random.choice(self.available_voices[voice_type])

            voice_profile = self.speaker_map[char_name]
            
            # Split text into manageable blocks (by sentences/paragraphs)
            # We use a regex that splits by sentence endings followed by space or newline
            raw_blocks = [s.strip() for s in re.split(r'(?<=[.!?])\s+|\n\n+', text) if s.strip()]
            
            # If no blocks (empty text), return None
            if not raw_blocks: return None

            async def synthesize_one(index: int, block_text: str):
                synthesis_input = texttospeech.SynthesisInput(text=block_text)
                voice = texttospeech.VoiceSelectionParams(
                    language_code="en-US",
                    name=voice_profile["name"]
                )
                audio_config = texttospeech.AudioConfig(
                    audio_encoding=texttospeech.AudioEncoding.MP3,
                    pitch=0.0,
                    speaking_rate=1.0
                )
                
                loop = asyncio.get_event_loop()
                response = await loop.run_in_executor(None, lambda: self.tts_client.synthesize_speech(
                    input=synthesis_input, voice=voice, audio_config=audio_config
                ))
                
                url = await self._upload_to_gcs(response.audio_content, "audio/mpeg", prefix=f"narration_{index}")
                return {
                    "index": index,
                    "speaker": char_name,
                    "text": block_text,
                    "audio_url": url
                }

            # Run all synthesis in parallel to keep it fast
            tasks = [synthesize_one(i, block) for i, block in enumerate(raw_blocks)]
            blocks = await asyncio.gather(*tasks)
            
            return {"type": "narration_track", "blocks": blocks}

        except Exception as e:
            print(f"Google TTS Error: {e}")
            import traceback
            traceback.print_exc()
            return None

    async def _generate_flash_image(self, prompt: str):
        try:
            # Reverted to stable gemini-1.5-flash
            model_id = "gemini-1.5-flash"
            
            # Use _safe_generate to handle rotation and errors
            response = await self._safe_generate("image", prompt, model=model_id)
            if not response: return None
            
            image_bytes = None
            for part in response.parts:
                if part.inline_data:
                    # Direct bytes from the response
                    image_bytes = part.inline_data.data
                    break
                elif hasattr(part, "as_image") or (part.inline_data and hasattr(part.inline_data, "as_image")):
                    # Support for SDK's as_image() helper if PIL is available
                    try:
                        img = part.as_image()
                        buf = io.BytesIO()
                        img.save(buf, format="PNG")
                        image_bytes = buf.getvalue()
                        break
                    except Exception as pil_err:
                        print(f"PIL Conversion Error: {pil_err}")
            
            if not image_bytes:
                print(f"Flash Image Error: No image data in response from {model_id}")
                return None
            
            url = await self._upload_to_gcs(image_bytes, "image/png", "scene")
            return {"type": "image", "content": url}
        except Exception as e:
            print(f"Flash Image Generation Error: {e}")
            return None

    # Alias for backward compatibility if needed, but we'll update internal calls
    async def _generate_imagen3(self, prompt: str):
        return await self._generate_flash_image(prompt)

    async def _generate_veo(self, prompt: str):
        """Generates cinematic motion using Vertex AI Veo with Flash Image reference."""
        if not self.vertex_client: return None
        try:
            # 1. First, decompose the prompt to generate high-quality reference subjects
            decomp_prompt = (
                f"Break down this cinematic video prompt into exactly 1 to 3 distinct visual subjects or key components "
                f"that should be generated as high-quality reference images for a video generator. "
                f"Return ONLY a JSON list of short image prompts. "
                f"Example: [\"Wide shot of the futuristic cityscape\", \"Close up of the cybernetic protagonist\"]\n\n"
                f"PROMPT: {prompt}"
            )
            
            res = await self._safe_generate("story", decomp_prompt, model="gemini-2.0-flash", 
                                           system_instr="Output ONLY a valid JSON list of strings.")
            
            ref_prompts = [prompt[:100]] # Default fallback
            if res and res.text:
                try:
                    text = res.text.strip()
                    if "```json" in text: text = text.split("```json")[1].split("```")[0].strip()
                    ref_prompts = json.loads(text)
                except: pass
            
            # 2. Generate reference images using gemini-1.5-flash
            references = []
            for ref_p in ref_prompts[:3]:
                img_res = await self._safe_generate("image", ref_p, model="gemini-1.5-flash")
                if img_res:
                    for part in img_res.parts:
                        # Fixed: use safe access for multimodal parts
                        if hasattr(part, "as_image"):
                            try:
                                img = part.as_image()
                                references.append(types.VideoGenerationReferenceImage(
                                    image=img,
                                    reference_type="asset"
                                ))
                                break
                            except: pass

            # 3. Generate video via Veo with references
            model_id = "veo-001"
            loop = asyncio.get_event_loop()
            
            config = types.GenerateVideosConfig(
                reference_images=references if references else None
            )
            
            operation = await loop.run_in_executor(None, lambda: self.vertex_client.models.generate_videos(
                model=model_id,
                prompt=f"Cinematic 4k movie clip: {prompt}. Professional lighting and motion.",
                config=config
            ))
            
            # Polling for completion
            while not operation.done:
                await asyncio.sleep(10)
                # Need to resolve operation inside lambda correctly, so pass it via parameter
                operation = await loop.run_in_executor(None, lambda op=operation: self.vertex_client.operations.get(op))
            
            res_video = operation.result.generated_videos[0]
            
            if hasattr(res_video.video, 'video_bytes') and res_video.video.video_bytes:
                video_bytes = res_video.video.video_bytes
                url = await self._upload_to_gcs(video_bytes, "video/mp4", "veo")
                return {"type": "video", "content": url}
                
            # If the result has a URI, use it directory (GCS path)
            if hasattr(res_video.video, 'uri') and res_video.video.uri:
                uri = res_video.video.uri
                if uri.startswith("gs://"):
                    parts = uri[5:].split("/", 1)
                    if len(parts) == 2:
                        try:
                            bucket = self.storage_client.bucket(parts[0])
                            blob = bucket.blob(parts[1])
                            video_bytes = await loop.run_in_executor(None, blob.download_as_bytes)
                            url = await self._upload_to_gcs(video_bytes, "video/mp4", "veo")
                            return {"type": "video", "content": url}
                        except Exception as e:
                            print(f"Failed to copy from gs:// : {e}")
                return {"type": "video", "content": uri}
            
            raise Exception("No video bytes or URI returned from Veo.")

        except Exception as e:
            import traceback
            traceback.print_exc()
            msg = str(e).upper()
            err_type = type(e).__name__
            print(f"Veo Error ({err_type}): {e}")
            # FALLBACK: If Veo is not available or errors, fallback to a static Flash Image
            if "NOT_FOUND" in msg or "404" in msg or "PERMISSION_DENIED" in msg:
                print(f"Falling back to Flash Image for cinematic visual ({prompt[:30]}...)")
                return await self._generate_flash_image(prompt)
            return None

    async def _generate_miro_diagram(self, json_str: str):
        """Creates a visual board in Miro for Workflow/Planning modes."""
        if not self.miro_token or not self.miro_board_id: return None
        try:
            # Logic for Miro API goes here (simplified)
            return {"type": "miro", "content": f"https://miro.com/app/board/{self.miro_board_id}"}
        except: return None

    async def generate_storybook_stream(self, prompt: str, mode: str = "Storybook", style: str = "Auto", ai_mode: str = "Auto", duration: str = "Short", keywords: list = None, narration: bool = True):
        """Async generator yielding text chunks and then assets."""
        duration_map = {
            "Short": "a short story (approx. 5 minutes).",
            "Medium": "a medium-length story.",
            "Large": "a long-form novel."
        }
        instr_length = duration_map.get(duration, duration_map["Short"])

        active_style = style
        if style == "Auto":
            yield {"type": "info", "content": "Analyzing vision..."}
            active_style = await self._detect_style(prompt, keywords, mode)
            yield {"type": "info", "content": f"Style: **{active_style}**"}

        if active_style == "Ghibli":
            active_style_desc = "Studio Ghibli aesthetic, anime hand-drawn style, lush painted backgrounds, whimsical and evocative lighting"
        elif active_style == "Noir":
            active_style_desc = "Noir style, high contrast black and white, moody shadows, rainy cinematic streets"
        else:
            active_style_desc = f"{active_style} visual style"

        story_instr = (
            f"You are a master storyteller specializing in the **{active_style}** aesthetic. "
            f"Every sentence must reflect the tone, atmosphere, and visual language of the {active_style} style. "
            f"Write {instr_length}. "
            f"IMPORTANT: All generated [IMAGE_PROMPT] and [VIDEO_PROMPT] tags MUST strictly adhere to the **{active_style_desc}**. "
            f"Example for {active_style}: if {active_style} is Noir, descriptions should mention high contrast shadows, rainy streets, and moody lighting."
        )
        
        full_text = ""
        img_pattern = re.compile(r"\[IMAGE_PROMPT:\s*(.*?)\]", re.IGNORECASE)
        vid_pattern = re.compile(r"\[VIDEO_PROMPT:\s*(.*?)\]", re.IGNORECASE)
        music_pattern = re.compile(r"\[MUSIC_STYLE:\s*(.*?)\]", re.IGNORECASE)
        
        async for chunk in self._safe_stream_generate("story", prompt, system_instr=story_instr, model="gemini-2.0-flash"):
            if chunk.text:
                full_text += chunk.text
                yield {"type": "text", "content": chunk.text}
                
                # Dynamic music swap
                m_match = music_pattern.search(chunk.text)
                if m_match:
                    yield {"type": "music", "content": m_match.group(1)}

        # Assets
        img_prompts = img_pattern.findall(full_text)
        vid_prompts = vid_pattern.findall(full_text)
        
        tasks = []
        for img_p in img_prompts[:2]:
            tasks.append(self._generate_flash_image(img_p))
        for vid_p in vid_prompts[:1]:
            tasks.append(self._generate_veo(vid_p))

        for task in asyncio.as_completed(tasks):
            res = await task
            if res: yield res

        # Generate narration if requested
        if narration:
            yield {"type": "info", "content": "Generating synchronized narration..."}
            # Clean text for TTS (remove prompt tags)
            clean_text = re.sub(r"\[IMAGE_PROMPT:.*?\]", "", full_text, flags=re.IGNORECASE)
            clean_text = re.sub(r"\[VIDEO_PROMPT:.*?\]", "", clean_text, flags=re.IGNORECASE)
            try:
                narration_res = await self._generate_google_tts(clean_text.strip(), active_style)
                if narration_res:
                    yield narration_res
                else:
                    yield {"type": "info", "content": "Narrator is unavailable for this tale."}
            except Exception as e:
                print(f"Initial TTS yielding error: {e}")
                yield {"type": "info", "content": "Narration forge failed. Visuals only."}

    async def continue_storybook_stream(self, prompt: str, existing_context: str, mode: str = "Storybook", style: str = "Cinematic", duration: str = "Short", keywords: list = None):
        """Continues an existing story based on previous context."""
        story_instr = (
            f"You are a master storyteller continuing a narrative in the **{style}** aesthetic. "
            f"Maintain strict consistency with the established style: {style}. "
            f"Continue based on the user's new prompt: '{prompt}'. "
            f"Include [IMAGE_PROMPT: description] for new scenes, ensuring they reflect the {style} visual language."
        )
        
        full_text = ""
        img_pattern = re.compile(r"\[IMAGE_PROMPT:\s*(.*?)\]", re.IGNORECASE)
        music_pattern = re.compile(r"\[MUSIC_STYLE:\s*(.*?)\]", re.IGNORECASE)
        
        # Combine context for the model
        combined_prompt = f"Existing Story Context:\n{existing_context}\n\nUser's Continuation Request: {prompt}"
        
        async for chunk in self._safe_stream_generate("story", combined_prompt, system_instr=story_instr, model="gemini-2.0-flash"):
            if chunk.text:
                full_text += chunk.text
                yield {"type": "text", "content": chunk.text}
                
                # Check for music style swaps in real-time
                m_match = music_pattern.search(chunk.text)
                if m_match:
                    yield {"type": "music", "content": m_match.group(1)}

        # Assets for continuation
        img_prompts = img_pattern.findall(full_text)
        tasks = []
        for img_p in img_prompts[:1]:
            tasks.append(self._generate_flash_image(img_p))

        for task in asyncio.as_completed(tasks):
            res = await task
            if res: yield res
        
        # Always generate a fresh narration for the continuation part
        yield {"type": "info", "content": "Generating synchronized narration for update..."}
        try:
            clean_text = re.sub(r"\[IMAGE_PROMPT:.*?\]", "", full_text, flags=re.IGNORECASE)
            narration_res = await self._generate_google_tts(clean_text.strip(), style)
            if narration_res:
                yield narration_res
            else:
                yield {"type": "info", "content": "Narrator is unavailable for this update."}
        except Exception as e:
            print(f"Continuation TTS yielding error: {e}")
            yield {"type": "info", "content": "Narration update failed."}

    async def generate_surprise_prompt(self, style: str = "Cinematic", ai_mode: str = "Auto", mode: str = "Storybook") -> str:
        prompt = f"Write a {mode} prompt (1-2 sentences) in a {style} style."
        sys_instr = "You are a prompt generator. You must output ONLY the raw prompt itself. NO introductory words, NO greetings, NO 'Here is your prompt'. Start immediately with the first word of the story prompt."
        res = await self._safe_generate("story", prompt, model="gemini-2.0-flash", system_instr=sys_instr)
        if res and res.text:
            text = res.text.strip()
            # Remove any asterisks
            text = text.replace("**", "")
            # If it still somehow added conversational filler containing a colon, grab what's after it
            if ":" in text and len(text.split(":")[0]) < 40:
                text = text.split(":", 1)[1].strip()
            return text
        return "A mysterious figure appears in the cinematic fog."
