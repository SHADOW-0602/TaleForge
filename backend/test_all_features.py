import asyncio
import os
import sys

# Ensure backend sits in path
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from gemini_client import GeminiClient

async def test_generation():
    print("Starting Feature Tests...")
    client = GeminiClient()
    
    # Check if keys are loaded
    print(f"Loaded {len(client.all_clients)} Gemini clients")
    
    test_configs = [
        # Test 1: Storybook, Short, with keywords and narration
        {"mode": "Storybook", "duration": "Short", "prompt": "A mini story about a tiny robot learning to love", "keywords": ["heart", "metal", "circuit"], "narration": True},
    ]
    
    for i, config in enumerate(test_configs):
        print(f"\n--- Running Test {i+1}: {config['mode']} / {config['duration']} ---")
        
        generator = client.generate_storybook_stream(
            prompt=config["prompt"],
            mode=config["mode"],
            style="Auto",
            ai_mode="Auto",
            duration=config["duration"],
            keywords=config["keywords"],
            narration=config.get("narration", False)
        )
        
        has_text = False
        assets = set()
        
        try:
            async for part in generator:
                if part["type"] == "text":
                    has_text = True
                elif part["type"] == "info":
                    print(f"Info: {part['content']}")
                else:
                    assets.add(part["type"])
                    content_preview = str(part.get("content", ""))
                    if isinstance(content_preview, str) and len(content_preview) > 60:
                        content_preview = content_preview[:60] + "..."
                    print(f"Asset: {part['type']} -> {content_preview}")
            
            print(f"\nTest {i+1} Finished.")
            print(f"- Text generated: {has_text}")
            print(f"- Assets generated: {assets}")
            
        except Exception as e:
            print(f"Test {i+1} FAILED: {e}")

if __name__ == "__main__":
    asyncio.run(test_generation())
