import "pako";

// pako keeps its zlib stream on every Inflate and @types/pako leaves it out. The pack parser reads
// strm.next_in to learn how many compressed bytes an entry consumed.
declare module "pako" {
  interface Inflate {
    strm: { next_in: number };
  }
}
