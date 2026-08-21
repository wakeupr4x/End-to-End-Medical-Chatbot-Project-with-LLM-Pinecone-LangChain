"""Diagnostic script to check what's in the Pinecone index and what the retriever returns."""
import os
from dotenv import load_dotenv
from helper import load_pdf_file, text_split, download_hugging_face_embeddings
from langchain_pinecone import PineconeVectorStore
from pinecone.grpc import PineconeGRPC as Pinecone

load_dotenv()
PINECONE_API_KEY = os.environ.get('PINECONE_API_KEY')

# 1. Check PDF loading
print("=" * 60)
print("STEP 1: Checking PDF loading...")
extracted_data = load_pdf_file(data='Data/')
print(f"  Pages loaded from PDF: {len(extracted_data)}")
if extracted_data:
    print(f"  First page preview (200 chars): {extracted_data[0].page_content[:200]}")

# 2. Check text splitting
print("\n" + "=" * 60)
print("STEP 2: Checking text splitting...")
text_chunks = text_split(extracted_data)
print(f"  Total text chunks: {len(text_chunks)}")
if text_chunks:
    print(f"  Sample chunk (200 chars): {text_chunks[0].page_content[:200]}")

# 3. Check embeddings
print("\n" + "=" * 60)
print("STEP 3: Loading embeddings model...")
embeddings = download_hugging_face_embeddings()
test_embedding = embeddings.embed_query("what is diabetes")
print(f"  Embedding dimension: {len(test_embedding)}")

# 4. Check Pinecone index stats
print("\n" + "=" * 60)
print("STEP 4: Checking Pinecone index stats...")
pc = Pinecone(api_key=PINECONE_API_KEY)
index = pc.Index("medicalbot")
stats = index.describe_index_stats()
print(f"  Index stats: {stats}")

# 5. Test retriever
print("\n" + "=" * 60)
print("STEP 5: Testing retriever with a query...")
docsearch = PineconeVectorStore.from_existing_index(
    index_name="medicalbot",
    embedding=embeddings
)
retriever = docsearch.as_retriever(search_type="similarity", search_kwargs={"k": 3})

test_queries = [
    "What is diabetes?",
    "What are the symptoms of flu?",
    "How to treat headache?"
]

for q in test_queries:
    print(f"\n  Query: '{q}'")
    docs = retriever.invoke(q)
    print(f"  Retrieved {len(docs)} documents")
    for i, doc in enumerate(docs):
        print(f"    Doc {i+1} (200 chars): {doc.page_content[:200]}")
    print()

print("=" * 60)
print("DIAGNOSTIC COMPLETE")
