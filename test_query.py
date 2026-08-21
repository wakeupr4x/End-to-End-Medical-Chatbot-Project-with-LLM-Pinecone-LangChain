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
os.environ["PINECONE_API_KEY"] = os.environ.get("PINECONE_API_KEY")
os.environ["GROQ_API_KEY"] = os.environ.get("GROQ_API_KEY")

embeddings = download_hugging_face_embeddings()
docsearch = PineconeVectorStore.from_existing_index(index_name="medicalbot", embedding=embeddings)
retriever = docsearch.as_retriever(search_type="similarity", search_kwargs={"k": 5})

# Test retrieval
print("=== RETRIEVED DOCS for 'Alanine aminotransferase test' ===")
docs = retriever.invoke("Alanine aminotransferase test")
for i, doc in enumerate(docs):
    print(f"\nDoc {i+1} (len={len(doc.page_content)}):")
    print(doc.page_content[:300])
    print("---")

# Test full chain
llm = ChatGroq(model_name="llama-3.3-70b-versatile", temperature=0.4, max_tokens=500)
prompt = ChatPromptTemplate.from_messages([("system", system_prompt), ("human", "{input}")])
question_answer_chain = create_stuff_documents_chain(llm, prompt)
rag_chain = create_retrieval_chain(retriever, question_answer_chain)

print("\n\n=== FULL CHAIN RESPONSE ===")
response = rag_chain.invoke({"input": "Alanine aminotransferase test"})
print("Answer:", response["answer"])
