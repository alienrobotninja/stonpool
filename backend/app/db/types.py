from sqlalchemy import BigInteger, String

# token base-unit amount. int64 is exact, orderable, and aggregatable on both sqlite
# (tests) and postgres (prod), and ample for <=9-decimal jettons (jUSDT/jUSDC are 6).
# 256-bit draw seeds are hashes, stored as hex strings, never as amounts.
Amount = BigInteger

Address = String(70)  # raw 0:hex (66) or user-friendly (48) both fit
TxHash = String(64)
Seed = String(66)  # 0x + 64 hex
