"""Test the full RAG chain end-to-end."""
import os
from dotenv import load_dotenv
from helper import download_hugging_face_embeddings
from langchain_pinecone import PineconeVectorStore
from langchain_groq import ChatGroq
from langchain_core.prompts import ChatPromptTemplate
from langchain_classic.chains import create_retrieval_chain
from langchain_classic.chains.combine_documents import create_stuff_documents_chain
from prompt import *

load_dotenv()

PINECONE_API_KEY = os.environ.get('PINECONE_API_KEY')
GROQ_API_KEY = os.environ.get('GROQ_API_KEY')

os.environ["PINECONE_API_KEY"] = PINECONE_API_KEY
os.environ["GROQ_API_KEY"] = GROQ_API_KEY

print("Loading embeddings...")
embeddings = download_hugging_face_embeddings()

print("Connecting to Pinecone...")
docsearch = PineconeVectorStore.from_existing_index(
    index_name="medicalbot",
    embedding=embeddings
)

retriever = docsearch.as_retriever(search_type="similarity", search_kwargs={"k": 3})

print("Setting up LLM...")
llm = ChatGroq(model_name="llama-3.3-70b-versatile", temperature=0.4, max_tokens=500)

prompt = ChatPromptTemplate.from_messages(
    [
        ("system", system_prompt),
        ("human", "{input}"),
    ]
)

question_answer_chain = create_stuff_documents_chain(llm, prompt)
rag_chain = create_retrieval_chain(retriever, question_answer_chain)

# Test with a question
test_q = "What is diabetes?"
print(f"\nAsking: '{test_q}'")
print("-" * 50)

response = rag_chain.invoke({"input": test_q})

print(f"Answer: {response['answer']}")
print(f"\nContext docs retrieved: {len(response.get('context', []))}")
for i, doc in enumerate(response.get('context', [])):
    print(f"  Doc {i+1}: {doc.page_content[:150]}...")
