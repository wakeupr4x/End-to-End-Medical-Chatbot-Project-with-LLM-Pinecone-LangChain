import io
import json
import os
import base64
import urllib.request
import urllib.error

from flask import Flask, jsonify, render_template, request, session
from flask_cors import CORS
from dotenv import load_dotenv
from google import genai
from google.genai import types as genai_types
from langchain_pinecone import PineconeVectorStore
from langchain_groq import ChatGroq
from langchain_core.messages import HumanMessage, SystemMessage, AIMessage
from pypdf import PdfReader

from helper import download_hugging_face_embeddings
from prompt import system_prompt

app = Flask(__name__)
app.secret_key = os.environ.get("FLASK_SECRET_KEY", "medibot-dev-secret")
CORS(app, supports_credentials=True, origins=["*"])

load_dotenv()

PINECONE_API_KEY = os.environ.get("PINECONE_API_KEY")
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")
GROQ_API_KEY = os.environ.get("GROQ_API_KEY")
XAI_API_KEY = os.environ.get("XAI_API_KEY") or os.environ.get("GROK_API_KEY")
XAI_MODEL = os.environ.get("XAI_MODEL", "grok-2-latest")
XAI_VISION_MODEL = os.environ.get("XAI_VISION_MODEL", XAI_MODEL)
GEMINI_TEXT_MODEL = os.environ.get("GEMINI_TEXT_MODEL", "gemini-2.0-flash")
GEMINI_VISION_MODEL = os.environ.get("GEMINI_VISION_MODEL", GEMINI_TEXT_MODEL)
XAI_TEXT_CANDIDATES = [XAI_MODEL, "grok-2-latest", "grok-2-1212", "grok-1.5-latest"]
XAI_VISION_CANDIDATES = [XAI_VISION_MODEL, "grok-2-vision-latest", "grok-2-vision-1212", "grok-2-latest"]

if PINECONE_API_KEY:
    os.environ["PINECONE_API_KEY"] = PINECONE_API_KEY

embeddings = download_hugging_face_embeddings()
index_name = "medicalbot"
docsearch = PineconeVectorStore.from_existing_index(index_name=index_name, embedding=embeddings)
retriever = docsearch.as_retriever(search_type="similarity", search_kwargs={"k": 5})

ai_client = genai.Client(api_key=GEMINI_API_KEY)

MAX_HISTORY_MESSAGES = 8

LANG_NAMES = {
    "en": None,
    "hi": "Hindi",
    "es": "Spanish",
    "fr": "French",
    "de": "German",
    "zh": "Chinese",
    "ar": "Arabic",
}


def load_history(history_str):
    try:
        history = json.loads(history_str)
        return history if isinstance(history, list) else []
    except json.JSONDecodeError:
        return []


def extract_pdf_text(file_storage):
    try:
        file_storage.stream.seek(0)
        reader = PdfReader(io.BytesIO(file_storage.read()))
        pages = []
        for page in reader.pages[:8]:
            text = page.extract_text() or ""
            if text.strip():
                pages.append(text.strip())
        return "\n\n".join(pages).strip()
    except Exception:
        return ""


def build_history_context(history):
    if not history:
        return ""

    lines = ["\n--- PREVIOUS CONVERSATION ---"]
    for item in history[-MAX_HISTORY_MESSAGES:]:
        role = "User" if item.get("sender") == "user" else "AI"
        lines.append(f"{role}: {item.get('text', '')}")
    lines.append("--- END PREVIOUS CONVERSATION ---\n")
    return "\n".join(lines)


def add_language_rule(prompt_text, lang):
    lang_name = LANG_NAMES.get(lang)
    if lang_name:
        return prompt_text + f"\n[IMPORTANT: You MUST write your response entirely in {lang_name}.]"
    return prompt_text


def add_attachment_rules(prompt_text, has_image=False, has_pdf=False):
    if has_pdf:
        prompt_text += (
            "\n[REPORT RULE: The user attached a medical report. "
            "Summarize the report, highlight abnormal or borderline values, explain them simply, "
            "and give concise next steps.]"
        )
    if has_image:
        prompt_text += (
            "\n[IMAGE RULE: Analyze the attached picture alongside the context chunks to formulate your response. "
            "Identify abnormal values if it is a report.]"
        )
    return prompt_text


def get_attachment():
    return request.files.get("attachment") or request.files.get("image")


def user_payload():
    user = session.get("user")
    if not user:
        return None
    return {
        "name": user.get("name"),
        "email": user.get("email"),
    }


def xai_chat_completion(messages, model_candidates=None, temperature=0.2):
    if not XAI_API_KEY:
        raise RuntimeError("XAI API key not configured")

    candidates = model_candidates or XAI_TEXT_CANDIDATES
    last_error = None
    for model_name in candidates:
        payload = {
            "model": model_name,
            "messages": messages,
            "temperature": temperature,
        }

        req = urllib.request.Request(
            "https://api.x.ai/v1/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {XAI_API_KEY}",
                "Content-Type": "application/json",
            },
            method="POST",
        )

        try:
            with urllib.request.urlopen(req, timeout=90) as response:
                data = json.loads(response.read().decode("utf-8"))
                return (data["choices"][0]["message"]["content"] or "").strip()
        except urllib.error.HTTPError as exc:
            last_error = exc
            try:
                detail = json.loads(exc.read().decode("utf-8"))
                message = detail.get("error", {}).get("message", "")
                if "model" not in message.lower() and "not found" not in message.lower():
                    raise
            except Exception:
                pass
        except Exception as exc:
            last_error = exc

    raise RuntimeError(f"xAI request failed: {last_error}")


def gemini_generate(parts, model):
    response = ai_client.models.generate_content(model=model, contents=parts)
    return (response.text or "").strip()


def compose_retrieval_prompt(context, lang, has_image=False, has_pdf=False, report_text=""):
    prompt_text = system_prompt.format(context=context)
    prompt_text = add_language_rule(prompt_text, lang)
    prompt_text = add_attachment_rules(prompt_text, has_image=has_image, has_pdf=has_pdf)
    prompt_text += build_history_context([])
    return prompt_text


@app.route("/")
def index():
    return render_template("chat.html")


@app.route("/api/me", methods=["GET"])
def me():
    return jsonify({"authenticated": bool(session.get("user")), "user": user_payload()})


@app.route("/api/login", methods=["POST"])
def login():
    payload = request.get_json(silent=True) or request.form or {}
    name = str(payload.get("name", "")).strip()
    email = str(payload.get("email", "")).strip()
    password = str(payload.get("password", "")).strip()

    if not name:
        return jsonify({"success": False, "error": "Name is required"}), 400

    session["user"] = {"name": name, "email": email, "has_password": bool(password)}
    return jsonify({"success": True, "user": user_payload()})


@app.route("/api/logout", methods=["POST"])
def logout():
    session.pop("user", None)
    return jsonify({"success": True})


def generate_response_with_provider(msg, lang, history, attachment, attachment_name, retrieved_context, transcription, audio_file):
    has_pdf = False
    has_image = False
    report_text = ""

    contents = []
    xai_messages = []

    if attachment and attachment_name:
        attachment_mime = attachment.content_type or ""
        if attachment_mime == "application/pdf" or attachment_name.lower().endswith(".pdf"):
            has_pdf = True
            report_text = extract_pdf_text(attachment)
            if report_text:
                retrieved_context = (
                    f"{retrieved_context}\n\nAttached report text:\n{report_text[:12000]}"
                    if retrieved_context
                    else f"Attached report text:\n{report_text[:12000]}"
                )
        else:
            has_image = True
            attachment.stream.seek(0)
            image_bytes = attachment.read()
            image_b64 = base64.b64encode(image_bytes).decode("utf-8")
            image_mime = attachment.content_type or "image/jpeg"
            data_url = f"data:{image_mime};base64,{image_b64}"
            xai_messages.append({
                "role": "user",
                "content": [
                    {"type": "text", "text": f"Analyze this medical image or report. Context: {retrieved_context}".strip()},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            })

    prompt_text = system_prompt.format(context=retrieved_context)
    prompt_text = add_language_rule(prompt_text, lang)
    prompt_text = add_attachment_rules(prompt_text, has_image=has_image, has_pdf=has_pdf)
    prompt_text += build_history_context(history)

    if XAI_API_KEY:
        try:
            messages = [
                {
                    "role": "system",
                    "content": prompt_text,
                }
            ]
            for item in history[-MAX_HISTORY_MESSAGES:]:
                role = "user" if item.get("sender") == "user" else "assistant"
                messages.append({
                    "role": role,
                    "content": str(item.get("text", "")),
                })
            if xai_messages:
                messages.extend(xai_messages)
            messages.append({
                "role": "user",
                "content": f"Patient Query: {msg if msg else 'Analyze the attached medical imagery data.'}",
            })
            return xai_chat_completion(messages, model_candidates=XAI_VISION_CANDIDATES if (has_image or has_pdf) else XAI_TEXT_CANDIDATES)
        except Exception as exc:
            print(f"xAI fallback triggered: {exc}")

    if audio_file and audio_file.filename:
        audio_bytes = audio_file.read()
        audio_part = genai_types.Part.from_bytes(
            data=audio_bytes,
            mime_type=audio_file.content_type or "audio/wav",
        )
        try:
            transcription_response = ai_client.models.generate_content(
                model=GEMINI_TEXT_MODEL,
                contents=[
                    audio_part,
                    "Provide a clean text transcription of this spoken health query. Skip intro or metadata lines.",
                ],
            )
            transcription = (transcription_response.text or "").strip()
            msg = transcription
        except Exception as e:
            print(f"Audio transcription failed: {e}")
            msg = "Could not transcribe audio due to AI provider rate limits. Please type your query."

    if has_image:
        attachment.stream.seek(0)
        image_bytes = attachment.read()
        image_part = genai_types.Part.from_bytes(
            data=image_bytes,
            mime_type=attachment.content_type or "image/jpeg",
        )
        contents.append(image_part)

    contents.append(prompt_text)
    contents.append(f"Patient Query: {msg if msg else 'Analyze the attached medical imagery data.'}")
    try:
        return gemini_generate(contents, GEMINI_VISION_MODEL if has_image else GEMINI_TEXT_MODEL)
    except Exception as exc:
        print(f"Gemini fallback failed: {exc}")
        if GROQ_API_KEY:
            try:
                print("Attempting Groq fallback (70b)...")
                llm = ChatGroq(model_name="llama-3.3-70b-versatile", temperature=0.2, api_key=GROQ_API_KEY)
                groq_messages = [
                    SystemMessage(content=prompt_text),
                    HumanMessage(content=f"Patient Query: {msg if msg else 'Analyze the attached medical imagery data.'}")
                ]
                response = llm.invoke(groq_messages)
                return response.content
            except Exception as groq_exc_70b:
                print(f"Groq 70b fallback failed: {groq_exc_70b}")
                try:
                    print("Attempting Groq fallback (8b)...")
                    llm_8b = ChatGroq(model_name="llama3-8b-8192", temperature=0.2, api_key=GROQ_API_KEY)
                    response_8b = llm_8b.invoke(groq_messages)
                    return response_8b.content
                except Exception as groq_exc_8b:
                    print(f"Groq 8b fallback failed: {groq_exc_8b}")
                    return (
                        f"I can’t reach the AI provider right now.\n"
                        f"Gemini error: {exc}\n"
                        f"Groq (70b) error: {groq_exc_70b}\n"
                        f"Groq (8b) error: {groq_exc_8b}"
                    )

        return (
            f"I can’t reach the AI provider right now. Gemini error: {exc} | No Groq API key found."
        )


@app.route("/api/chat", methods=["POST"])
def chat():
    try:
        msg = request.form.get("msg", "").strip()
        lang = request.form.get("lang", "en")
        history = load_history(request.form.get("history", "[]"))

        audio_file = request.files.get("audio")
        attachment = get_attachment()
        attachment_name = attachment.filename if attachment and attachment.filename else ""

        transcription = None

        retrieval_query = msg
        retrieved_context = ""
        sources = []
        if retrieval_query:
            try:
                docs = retriever.invoke(retrieval_query)
                retrieved_context = "\n\n".join(doc.page_content for doc in docs)
                for doc in docs:
                    meta_source = doc.metadata.get("source")
                    if meta_source:
                        basename = os.path.basename(meta_source)
                        # Clean up name: remove extension, replace separators with spaces, title case
                        name, ext = os.path.splitext(basename)
                        clean_name = name.replace("_", " ").replace("-", " ").title()
                        
                        page = doc.metadata.get("page")
                        if page is not None:
                            try:
                                page_num = int(page) + 1
                                clean_name = f"{clean_name}, p. {page_num}"
                            except ValueError:
                                pass
                        
                        if clean_name not in sources:
                            sources.append(clean_name)
            except Exception as e:
                print(f"Retrieval error: {e}")
                retrieved_context = ""

        response_text = generate_response_with_provider(
            msg=msg,
            lang=lang,
            history=history,
            attachment=attachment,
            attachment_name=attachment_name,
            retrieved_context=retrieved_context,
            transcription=transcription,
            audio_file=audio_file,
        )

        return jsonify(
            {
                "success": True,
                "text": response_text,
                "transcription": transcription,
                "sources": sources,
                "meta": {
                    "language": lang,
                    "has_image": bool(attachment and attachment_name and attachment_name.lower().endswith(('.png', '.jpg', '.jpeg', '.webp'))),
                    "has_pdf": bool(attachment and attachment_name and attachment_name.lower().endswith('.pdf')),
                    "attachment_name": attachment_name or None,
                },
            }
        )
    except Exception as exc:
        import traceback

        traceback.print_exc()
        return jsonify({"success": False, "error": str(exc) or "An internal error occurred."}), 500


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port, debug=False)
