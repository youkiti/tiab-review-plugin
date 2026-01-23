/**
 * jstat ライブラリの型定義
 */
declare module 'jstat' {
    interface HypGeom {
        /** 超幾何分布の確率質量関数 */
        pdf(k: number, N: number, K: number, n: number): number;
        /** 超幾何分布の累積分布関数 */
        cdf(k: number, N: number, K: number, n: number): number;
    }

    interface JStat {
        hypgeom: HypGeom;
    }

    const jStat: JStat;
    export default jStat;
}
