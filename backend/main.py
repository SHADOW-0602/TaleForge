from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from gemini_client import GeminiClient
import json
import asyncio
import traceback
import uuid
from datetime import datetime
from database import db

app = FastAPI(title="TaleForge API")

# Enable CORS for frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
async def root():
    return {"message": "TaleForge API is running", "version": "1.0.0"}

gemini = GeminiClient()

# Added Pydantic models
class StoryRequest(BaseModel):
    prompt: str
    mode: str = "Storybook"
    style: str = "Cinematic"
    ai_mode: str = "Auto"
    duration: str = "Short"
    keywords: list[str] = []
    narration: bool = True

class KeywordRequest(BaseModel):
    keywords: list[str]

@app.websocket("/ws/generate")
async def generate_tale_ws(websocket: WebSocket):
    await websocket.accept()
    print("WS Connection Accepted. Waiting for payload...", flush=True)
    try:
        # Wait for the initial configuration
        config_data = await websocket.receive_text()
        request_dict = json.loads(config_data)
        print(f"Payload parsed. Prompt: {request_dict.get('prompt', '')[:50]}...", flush=True)

        prompt = request_dict.get("prompt", "")
        mode = request_dict.get("mode", "Storybook")
        style = request_dict.get("style", "Cinematic")
        ai_mode = request_dict.get("ai_mode", "Auto")
        duration = request_dict.get("duration", "Short")
        keywords = request_dict.get("keywords", [])
        narration = request_dict.get("narration", True)
        existing_chat_id = request_dict.get("chat_id", None)

        full_text = ""
        assets = []
        
        if existing_chat_id:
            # --- CONTINUE EXISTING CHAT ---
            chat_id = existing_chat_id
            existing_record = await db.get_chat_by_id(chat_id)
            if not existing_record:
                await websocket.send_json({"type": "error", "content": "Chat not found for continuation."})
                await websocket.close()
                return

            existing_context = existing_record.get("full_text", "")
            
            # Send an immediate ping to frontend to confirm continuation started
            await websocket.send_json({"type": "info", "content": "Continuing story..."})
            
            # Iterate over the continuation generator
            async for part in gemini.continue_storybook_stream(prompt, existing_context, mode, style, duration, keywords):
                if part.get("type") == "text":
                    full_text += part.get("content", "")
                elif part.get("type") in ["image", "video", "audio", "blueprint", "narration_track"]:
                    assets.append(part)
                await websocket.send_json(part)
                
            if full_text or assets:
                 asyncio.create_task(db.append_chat_record(chat_id, f"**Prompt Update:** {prompt}\n\n" + full_text, assets))

        else:
            # --- NEW CHAT ---
            chat_id = uuid.uuid4().hex
            asyncio.create_task(db.create_chat_record(chat_id, prompt, mode, style))

            # Yield the optimistic history record instantly
            await websocket.send_json({
                "type": "history_meta",
                "chat": {
                    "id": chat_id,
                    "prompt": prompt,
                    "mode": mode,
                    "style": style,
                    "created_at": datetime.utcnow().isoformat()
                }
            })
            
            # Iterate over the new story generator
            async for part in gemini.generate_storybook_stream(prompt, mode, style, ai_mode, duration, keywords, narration):
                if part.get("type") == "text":
                    full_text += part.get("content", "")
                elif part.get("type") in ["image", "video", "audio", "blueprint", "narration_track"]:
                    assets.append(part)
                await websocket.send_json(part)
            
            print(f"Generator loop finished. Total text length: {len(full_text)}, Assets: {len(assets)}", flush=True)
                
            # Fire and forget the final commit
            if full_text or assets:
                 asyncio.create_task(db.finalize_chat_record(chat_id, full_text, assets))

        # Close normally when done
        await websocket.close()

    except WebSocketDisconnect:
        print("DEBUG: WebSocket disconnected by client")
    except Exception as e:
        traceback.print_exc()
        try:
            await websocket.send_json({"type": "error", "content": str(e)})
            await websocket.close(code=1011, reason="Internal Error")
        except:
            pass # if socket is already closed



@app.post("/surprise")
async def surprise_me(request: dict):
    print(f"DEBUG: /surprise request received: {request}")
    style = request.get("style", "Cinematic")
    ai_mode = request.get("ai_mode", "Auto")
    mode = request.get("mode", "Storybook")
    try:
        new_prompt = await gemini.generate_surprise_prompt(style, ai_mode, mode)
        return {"prompt": new_prompt}
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/history")
async def get_chat_history():
    print("DEBUG: /history request received")
    try:
        history = await db.get_chat_history()
        return {"history": history}
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/health")
async def health():
    return {"status": "ok"}

@app.get("/history/{chat_id}")
async def get_history_detail(chat_id: str):
    print(f"DEBUG: /history/{chat_id} request received")
    try:
        chat = await db.get_chat_by_id(chat_id)
        if not chat:
            raise HTTPException(status_code=404, detail="Chat not found")
        return {"chat": chat}
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/history/{chat_id}")
async def delete_history_detail(chat_id: str):
    print(f"DEBUG: DELETE /history/{chat_id} request received")
    try:
        success = await db.delete_chat(chat_id)
        if not success:
            raise HTTPException(status_code=404, detail="Chat not found or could not be deleted")
        return {"status": "success", "message": "Chat deleted successfully"}
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
