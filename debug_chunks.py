"""Check what chunks were actually created from the PDF for ALT-related content."""
from helper import load_pdf_file, text_split

# Load and split
extracted_data = load_pdf_file(data='Data/')
text_chunks = text_split(extracted_data)

print(f"Total chunks: {len(text_chunks)}")
print(f"Average chunk length: {sum(len(c.page_content) for c in text_chunks) / len(text_chunks):.0f} chars")
print()

# Find chunks related to Alanine aminotransferase
print("=== Chunks containing 'alanine' ===")
alanine_chunks = [c for c in text_chunks if 'alanine' in c.page_content.lower()]
print(f"Found {len(alanine_chunks)} chunks")
for i, c in enumerate(alanine_chunks[:5]):
    print(f"\nChunk {i+1} (len={len(c.page_content)}):")
    print(c.page_content[:500])
    print("---")

# Also check for very short chunks (potential issue)
short_chunks = [c for c in text_chunks if len(c.page_content) < 50]
print(f"\n\n=== Very short chunks (< 50 chars): {len(short_chunks)} out of {len(text_chunks)} ===")
for c in short_chunks[:10]:
    print(f"  [{len(c.page_content)} chars] '{c.page_content}'")

# Check empty-ish chunks
empty_ish = [c for c in text_chunks if len(c.page_content.strip()) < 100]
print(f"\n=== Chunks under 100 chars: {len(empty_ish)} out of {len(text_chunks)} ===")
