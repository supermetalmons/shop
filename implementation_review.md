# Implementation Review: plan_clean.md vs Codebase

### 3. ClaimForm Success Message Is Misleading
**Location:** `src/components/ClaimForm.tsx` line 20
```typescript
setSuccess('Claim request sent. We auto-selected your blind box certificate.');
```
**Issue:** The message says "We auto-selected your blind box certificate" but the UI doesn't actually select anything visible. The backend finds the certificate automatically, but this message may confuse users.  
**Suggestion:** Rephrase to something like "Claim submitted successfully! Your dude certificates are being minted."

### 5. `syncMintedFromChain` Called on Every Request
**Location:** `functions/src/index.ts` lines 260-280, called in `/stats` and `/prepareMintTx`  
**Issue:** This function iterates through chain transactions to sync mint records. On high traffic, this could be slow and redundant.  
**Impact:** Potentially slow response times for `/stats` endpoint.  
**Suggestion:** Run sync as a scheduled job or cache results with TTL.

### 9. Country Selection Limited
**Location:** `src/lib/countries.ts`  
**Issue:** Only ~13 countries listed. Users from other countries must select "Other (International)" which gives no country-specific feedback.