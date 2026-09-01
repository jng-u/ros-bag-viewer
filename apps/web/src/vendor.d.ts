declare module "seek-bzip" {
  interface ByteOutput {
    writeByte(value: number): void;
    write?(bytes: ArrayLike<number>, offset: number, length: number): number;
  }

  const Bunzip: {
    decode(input: Uint8Array, output: ByteOutput, multistream?: boolean): void;
  };
  export default Bunzip;
}
