export function up2kChunksize(filesize: number): number {
  let chunksize = 1024 * 1024;
  let stepsize = 512 * 1024;
  while (true) {
    for (let mul = 1; mul <= 2; mul++) {
      const nchunks = Math.ceil(filesize / chunksize);
      if (nchunks <= 256 || (chunksize >= 32 * 1024 * 1024 && nchunks <= 4096)) {
        return chunksize;
      }
      chunksize += stepsize;
      stepsize *= mul;
    }
  }
}

export function chunkRanges(filesize: number, chunksize: number): { car: number; cdr: number }[] {
  const ranges: { car: number; cdr: number }[] = [];
  let car = 0;
  while (car < filesize) {
    const cdr = Math.min(car + chunksize, filesize);
    ranges.push({ car, cdr });
    car = cdr;
  }
  return ranges;
}
