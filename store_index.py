import os
import re
from dotenv import load_dotenv
from helper import load_pdf_file, text_split, download_hugging_face_embeddings
from pinecone.grpc import PineconeGRPC as Pinecone
from pinecone import ServerlessSpec
from langchain_pinecone import PineconeVectorStore
import time

load_dotenv()

PINECONE_API_KEY = os.environ.get('PINECONE_API_KEY')

print("Loading PDF data...")
extracted_data = load_pdf_file(data='Data/')
print(f"  Loaded {len(extracted_data)} pages from PDF")

text_chunks = text_split(extracted_data)
print(f"  Split into {len(text_chunks)} chunks")

def is_quality_chunk(chunk):
    text = chunk.page_content.strip()
    if len(text) < 100:
        return False
    if re.match(r'^GEM\s*-\s*\d+', text):
        return False
    return True

filtered_chunks = [c for c in text_chunks if is_quality_chunk(c)]
print(f"  After filtering: {len(filtered_chunks)} quality chunks.")

embeddings = download_hugging_face_embeddings()

pc = Pinecone(api_key=PINECONE_API_KEY)
index_name = "medicalbot"

existing_indexes = [index_info["name"] for index_info in pc.list_indexes()]

if index_name in existing_indexes:
    print(f"Deleting old index '{index_name}'...")
    pc.delete_index(index_name)
    time.sleep(5)

print(f"Creating fresh index: {index_name}")
pc.create_index(
    name=index_name,
    dimension=384,
    metric="cosine",
    spec=ServerlessSpec(cloud="aws", region="us-east-1")
)

while not pc.describe_index(index_name).status['ready']:
    time.sleep(1)
print("  Index is ready!")

print(f"Uploading {len(filtered_chunks)} embeddings to Pinecone...")
docsearch = PineconeVectorStore.from_documents(
    documents=filtered_chunks,
    index_name=index_name,
    embedding=embeddings,
)
print("Success! Data indexed.")