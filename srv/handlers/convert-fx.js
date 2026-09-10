module.exports = function registerConvertFxHandler(service, deps){

    const { cds, SELECT, INSERT, entities, adapters } = deps;
    const{Receipts, FxRates} = entities;
    const{ getFxRate } = adapters;


    service.on("convertFx", async (req) => {

        console.log(">>> convertFx handler reached");
        console.log("incoming data:", req.data);

        const { receiptId, toCurrency } = req.data || {};
        if (!receiptId) return req.reject(400, "receiptId is required");
        if (!toCurrency) return req.reject(400, "toCurrency is required");
    
        const r = await SELECT.one.from(Receipts).where({ ID: receiptId });
        if (!r) return req.reject(404, "Receipt not found");
        if (!r.currency || r.totalAmount == null) {
        return req.reject(400, "Need currency and totalAmount (extract first)");
        }
    
        if (!FxRates) {
        return req.reject(
            500,
            "Service entity 'FxRates' not found. Expose it in copilot-service.cds (projection on db.FxRateCache)."
        );
        }
    
        const base = String(r.currency).toUpperCase();
        const symbol = String(toCurrency).toUpperCase();
        const original = Number(r.totalAmount);
        
        const rateDate = r.receiptDate
        ? String(r.receiptDate).slice(0, 10)
        : new Date().toISOString().slice(0, 10);    
        
        console.log("rateDate==", rateDate);
        console.log("base==", base);
        console.log("Symbol==", symbol );

        if (base === symbol) {
            return {
            rateDate,
            base,
            symbol,
            original,
            rate: 1,
            converted: Number(original.toFixed(2)),
            source: "identity",
            effectiveDate: rateDate,
        };
        }
    
        let cached = await SELECT.one.from(FxRates).where({ rateDate, base, symbol });
    
        if (!cached) {
        const fx = await getFxRate(rateDate, base, symbol);
    
        await INSERT.into(FxRates).entries({
            ID: cds.utils.uuid(),
            rateDate,
            base,
            symbol,
            rate: fx.rate,
            source: fx.source,
        });
    
        cached = {
            rate: fx.rate,
            source: fx.source,
            effectiveDate: fx.effectiveDate ?? rateDate,
        };
        }
    
        const rate = Number(cached.rate);
        const converted = Number((original * rate).toFixed(2));
    
        return {
        rateDate,
        base,
        symbol,
        original,
        rate,
        converted,
        source: cached.source,
        effectiveDate: cached.effectiveDate ?? rateDate,
        };
    });
}