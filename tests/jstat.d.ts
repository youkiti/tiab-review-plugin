declare module 'jstat' {
    const jStat: {
        hypgeom: {
            cdf(k: number, N: number, K: number, n: number): number;
        };
    };
    export default jStat;
}
