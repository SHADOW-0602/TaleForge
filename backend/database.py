import os
import json
import uuid
import requests
import asyncio
from datetime import datetime
from dotenv import load_dotenv

load_dotenv()

class DatabaseClient:
    def __init__(self):
        self.account_id = os.getenv("CLOUDFLARE_ACCOUNT_ID")
        self.db_id = os.getenv("CLOUDFLARE_D1_DATABASE_ID")
        self.api_token = os.getenv("CLOUDFLARE_API_TOKEN")

        if self.account_id and self.db_id and self.api_token:
            self.base_url = f"https://api.cloudflare.com/client/v4/accounts/{self.account_id}/d1/database/{self.db_id}/query"
            self.headers = {
                "Authorization": f"Bearer {self.api_token}",
                "Content-Type": "application/json"
            }
            # Fire and forget table creation on init
            try:
                loop = asyncio.get_event_loop()
                loop.create_task(self.init_d1_schema())
            except Exception:
                pass
        else:
            print("WARNING: Cloudflare D1 credentials missing. Database logging disabled.")
            self.base_url = None

    async def _execute_query(self, sql: str, params: list = None):
        if not self.base_url:
            return None
        
        payload = {"sql": sql}
        if params:
            payload["params"] = params

        def make_req():
            try:
                res = requests.post(self.base_url, headers=self.headers, json=payload, timeout=5)
                res.raise_for_status()
                return res.json()
            except Exception as e:
                print(f"D1 Database Error executing: {sql[:50]}... -> {e}")
                return None
                
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, make_req)

    async def init_d1_schema(self):
        """Creates the chats table if it doesn't already exist."""
        sql = """
            CREATE TABLE IF NOT EXISTS chats (
                id TEXT PRIMARY KEY,
                prompt TEXT,
                mode TEXT,
                style TEXT,
                full_text TEXT,
                assets TEXT,
                created_at TEXT
            );
        """
        await self._execute_query(sql)
        print("D1 Schema Initialized.")

    async def create_chat_record(self, chat_id: str, prompt: str, mode: str, style: str):
        """Creates an initial row for a prompt before streaming starts."""
        sql = "INSERT Into chats (id, prompt, mode, style, created_at) VALUES (?, ?, ?, ?, ?)"
        created_at = datetime.utcnow().isoformat()
        await self._execute_query(sql, [chat_id, prompt, mode, style, created_at])

    async def finalize_chat_record(self, chat_id: str, full_text: str, assets: list):
        """Updates the row with the final generated text and assets once stream completes."""
        sql = "UPDATE chats SET full_text = ?, assets = ? WHERE id = ?"
        assets_json = json.dumps(assets)
        await self._execute_query(sql, [full_text, assets_json, chat_id])

    async def append_chat_record(self, chat_id: str, added_text: str, added_assets: list):
        """Appends new text and assets to an existing story (Continue Chat)."""
        existing = await self.get_chat_by_id(chat_id)
        if not existing:
            print(f"Warning: Cannot append to missing chat {chat_id}")
            return
            
        current_text = existing.get("full_text") or ""
        current_assets_str = existing.get("assets") or "[]"
        
        try:
            current_assets = json.loads(current_assets_str)
        except:
            current_assets = []
            
        new_full_text = current_text + "\n\n" + added_text
        new_assets = current_assets + added_assets
        
        sql = "UPDATE chats SET full_text = ?, assets = ? WHERE id = ?"
        await self._execute_query(sql, [new_full_text, json.dumps(new_assets), chat_id])

    async def get_chat_history(self):
        """Fetches the 50 most recent chat records."""
        sql = "SELECT id, prompt, mode, style, created_at FROM chats ORDER BY created_at DESC LIMIT 50"
        result = await self._execute_query(sql)
        
        if result and result.get("success") and result.get("result"):
            # Cloudflare D1 REST API returns results in a nested lists/objects format depending on version
            # Usually result["result"][0]["results"] holds the rows.
            try:
                rows = result["result"][0]["results"]
                return rows
            except (IndexError, KeyError):
                return []
        return []

    async def get_chat_by_id(self, chat_id: str):
        """Fetches the full content for a single chat record."""
        sql = "SELECT id, prompt, mode, style, full_text, assets, created_at FROM chats WHERE id = ?"
        result = await self._execute_query(sql, [chat_id])
        
        if result and result.get("success") and result.get("result"):
            try:
                rows = result["result"][0]["results"]
                if rows: return rows[0]
            except (IndexError, KeyError):
                pass
        return None

    async def delete_chat(self, chat_id: str):
        """Deletes a chat record from the database."""
        sql = "DELETE FROM chats WHERE id = ?"
        result = await self._execute_query(sql, [chat_id])
        return result and result.get("success", False)

db = DatabaseClient()
