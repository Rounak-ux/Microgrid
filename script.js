/**
 * ============================================================
 *  SMART MICROGRID EMS — SCRIPT.JS
 *  Version 2.1.0 | Modular Architecture
 *  ─────────────────────────────────────────────────────────
 *  Modules:
 *    1. CONFIG          — Constants and design tokens
 *    2. STATE           — Centralised state store
 *    3. WeatherModule   — OpenWeatherMap integration
 *    4. PhysicsModule   — Power model (solar, wind, battery)
 *    5. AIEngine        — Decision logic (all rules)
 *    6. SimModule       — Simulation data generation
 *    7. HardwareModule  — ESP32/Firebase placeholder
 *    8. UIRenderer      — All DOM updates
 *    9. ChartModule     — Canvas chart rendering
 *   10. Controls        — Sliders, buttons, toggles
 *   11. App             — Boot + main loop
 * ============================================================
 */

'use strict';

// ============================================================
//  MODULE 1: CONFIG
// ============================================================
const CONFIG = {
    // OpenWeatherMap
    OWM_KEY: '0ffe3225b6013ac102a142367351706d',
    OWM_URL: 'https://api.openweathermap.org/data/2.5',

    // Default location
    DEFAULT_CITY: 'Asansol',
    DEFAULT_LAT: 23.6833,
    DEFAULT_LON: 86.9667,

    // Grid System
    GRID_A_MVA: 6,
    GRID_B_MVA: 5,
    TOTAL_MVA: 11,
    LOAD_NOMINAL: 10,   // MW

    // Solar
    SOLAR_PANEL_KWP: 9600,   // kWp installed (9.6 MWp)
    SOLAR_EFFICIENCY: 0.95,
    SOLAR_TEMP_COEFF: -0.004, // per °C above 25°C

    // Wind Turbine
    WIND_K_COEFF: 0.0015, // scaling constant k
    WIND_CUT_IN: 3,      // m/s
    WIND_RATED: 12,     // m/s
    WIND_CUT_OUT: 25,     // m/s
    WIND_RATED_MW: 5.0,    // MW at rated speed

    // Battery
    BATT_CAPACITY_KWH: 50000,   // kWh (50 MWh system)
    BATT_MAX_KW: 8000,    // kW charge/discharge
    BATT_SOC_MIN: 20,      // %
    BATT_SOC_MAX: 90,      // %
    BATT_SOC_EV: 70,      // % threshold for EV on
    BATT_SOC_CRITICAL: 20,      // %
    BATT_SOC_RESERVE: 40,      // % minimum reserve (bad weather)

    // EV
    EV_CAPACITY_KWH: 60,      // kWh
    EV_CHARGE_RATE_KW: 22,      // kW

    // CO2
    GRID_EMISSION_KG_PER_KWH: 0.82,
    SOLAR_EMISSION: 0.06,
    WIND_EMISSION: 0.02,

    // Timings
    WEATHER_INTERVAL_MS: 600000,  // 10 min
    PHYSICS_INTERVAL_MS: 3000,    // 3 sec
    UI_INTERVAL_MS: 1000,    // 1 sec
    CHART_HISTORY: 24,      // data points

    // Duty Cycle
    DUTY_CYCLE_DAYS: 2,
};

// ============================================================
//  MODULE 2: STATE
// ============================================================
const STATE = {
    // Mode
    mode: 'simulation',    // 'simulation' | 'hardware'
    isIslandMode: false,
    isAutoMode: true,
    drActive: false,

    // Location
    location: {
        name: CONFIG.DEFAULT_CITY,
        lat: CONFIG.DEFAULT_LAT,
        lon: CONFIG.DEFAULT_LON,
        country: 'IN',
    },

    // Weather
    weather: {
        temp: null,
        windSpeed: null,
        humidity: null,
        clouds: null,
        condition: null,
        icon: null,
        pressure: null,
        visibility: null,
        irradiance: null,
        forecast: [],
        badForecast: false,
        lastFetched: null,
    },

    // Power (MW)
    power: {
        solar: 0,
        wind: 0,
        totalGen: 0,
        load: CONFIG.LOAD_NOMINAL,
        battery: 0,       // + = charging, - = discharging
        ev: 0,
        export: 0,
        excess: 0,
    },

    // Battery
    battery: {
        soc: 75,
        voltage: 50,
        current: 0,
        temp: 28,
        state: 'IDLE',   // CHARGING | DISCHARGING | IDLE
        health: 94,
        etaHours: null,
    },

    // EV
    ev: {
        active: false,
        battPct: 30,
        sessionKWh: 0,
        queue: 0,
        etaMin: null,
        chargeRateKW: 0,
    },

    // Grid A
    gridA: {
        active: true,
        fault: false,
        outputMW: 0,
        loadPct: 0,
        mode: 'Supply',
        freq: 50.0,
        voltage: 11.0,
        pf: 0.92,
        stability: 95,
    },

    // Grid B
    gridB: {
        active: true,
        fault: false,
        outputMW: 0,
        loadPct: 0,
        mode: 'Charging',
        freq: 50.0,
        voltage: 11.0,
        pf: 0.91,
        stability: 92,
    },

    // AI
    ai: {
        case: '',
        title: 'Initializing',
        desc: 'Loading system data...',
        icon: '🧠',
        variant: 'default',  // default | success | warning | critical
        dutyCycle: {
            day: 0,
            charging: '--',
            priority: '--',
            dr: '--',
        },
        log: [],
    },

    // Fault
    fault: {
        active: false,
        type: null,     // 'A' | 'B' | 'both' | 'battery'
        events: [],
    },

    // Carbon
    carbon: {
        totalKg: 0,
        solarKg: 0,
        windKg: 0,
        sessionStart: Date.now(),
    },

    // Charts
    chart: {
        labels: [],
        solar: [],
        wind: [],
        load: [],
        soc: [],
    },

    // Counters
    _tick: 0,
    _nextWeather: 0,
    _nextPhysics: CONFIG.PHYSICS_INTERVAL_MS / 1000,
};

// ============================================================
//  MODULE 3: WEATHER MODULE
// ============================================================
const WeatherModule = (() => {

    /**
     * Main fetch — pulls current weather + 5-day forecast.
     * Falls back to simulation if API fails.
     */
    async function fetch(lat, lon) {
        try {
            const [curRes, fcRes] = await Promise.all([
                window.fetch(`${CONFIG.OWM_URL}/weather?lat=${lat}&lon=${lon}&units=metric&appid=${CONFIG.OWM_KEY}`),
                window.fetch(`${CONFIG.OWM_URL}/forecast?lat=${lat}&lon=${lon}&units=metric&cnt=8&appid=${CONFIG.OWM_KEY}`),
            ]);

            if (!curRes.ok) throw new Error(`HTTP ${curRes.status}`);

            const cur = await curRes.json();
            const fc = fcRes.ok ? await fcRes.json() : { list: [] };

            _parse(cur, fc);
            UIRenderer.setLiveIndicator(true);
            addLog('Weather data refreshed from OpenWeatherMap', 'info');
            UIRenderer.showToast('Weather data updated', 'success');
        } catch (err) {
            console.warn('WeatherModule fetch error:', err);
            _simulateFallback();
            UIRenderer.setLiveIndicator(false);
        }
    }

    function _parse(cur, fc) {
        const hour = new Date().getHours();
        const clouds = cur.clouds?.all ?? 40;
        const wind = cur.wind?.speed ?? 5;

        STATE.weather = {
            temp: Math.round(cur.main?.temp ?? 30),
            windSpeed: parseFloat((wind).toFixed(1)),
            humidity: cur.main?.humidity ?? 65,
            clouds: clouds,
            condition: cur.weather?.[0]?.description ?? 'partly cloudy',
            icon: cur.weather?.[0]?.main ?? 'Clouds',
            pressure: cur.main?.pressure ?? 1012,
            visibility: Math.round((cur.visibility ?? 8000) / 1000),
            irradiance: _computeIrradiance(clouds, hour, cur.main?.temp ?? 30),
            forecast: _parseForecast(fc?.list ?? []),
            badForecast: _checkBadForecast(fc?.list ?? []),
            lastFetched: new Date().toLocaleTimeString('en-IN', { hour12: false }),
        };
        STATE._nextWeather = CONFIG.WEATHER_INTERVAL_MS / 1000;
    }

    function _parseForecast(list) {
        return list.slice(0, 6).map(item => ({
            time: new Date(item.dt * 1000).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false }),
            icon: _iconEmoji(item.weather?.[0]?.main),
            temp: Math.round(item.main?.temp),
            wind: parseFloat((item.wind?.speed ?? 0).toFixed(1)),
            clouds: item.clouds?.all ?? 0,
        }));
    }

    function _checkBadForecast(list) {
        return list.some(item =>
            (item.clouds?.all ?? 0) > 80 ||
            (item.weather?.[0]?.main ?? '').match(/Rain|Snow|Thunderstorm/)
        );
    }

    function _computeIrradiance(cloudPct, hour, temp) {
        const peakW = 1000;
        const hourFac = Math.max(0, Math.sin(Math.PI * (hour - 6) / 12));
        const cloudFac = 1 - (cloudPct / 100) * 0.75;
        // Temperature derating: hot weather reduces panel output
        const tempDerate = 1 + CONFIG.SOLAR_TEMP_COEFF * Math.max(0, temp - 25);
        return Math.round(peakW * hourFac * cloudFac * tempDerate);
    }

    function _simulateFallback() {
        const hour = new Date().getHours();
        STATE.weather = {
            temp: Math.round(28 + Math.random() * 6),
            windSpeed: parseFloat((3 + Math.random() * 9).toFixed(1)),
            humidity: Math.round(55 + Math.random() * 20),
            clouds: Math.round(20 + Math.random() * 40),
            condition: 'partly cloudy (simulated)',
            icon: 'Clouds',
            pressure: Math.round(1010 + Math.random() * 5),
            visibility: Math.round(8 + Math.random() * 4),
            irradiance: _computeIrradiance(35, hour, 30),
            forecast: Array.from({ length: 6 }, (_, i) => ({
                time: new Date(Date.now() + i * 3 * 3600000)
                    .toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false }),
                icon: '⛅', temp: Math.round(28 + Math.random() * 5),
                wind: parseFloat((3 + Math.random() * 8).toFixed(1)), clouds: 35,
            })),
            badForecast: false,
            lastFetched: new Date().toLocaleTimeString('en-IN') + ' (sim)',
        };
    }

    function _iconEmoji(main) {
        const m = {
            Clear: '☀️', Clouds: '⛅', Rain: '🌧️', Drizzle: '🌦️',
            Thunderstorm: '⛈️', Snow: '❄️', Mist: '🌫️', Fog: '🌫️', Haze: '🌤️',
        };
        return m[main] ?? '🌤️';
    }

    async function fetchByCity(city) {
        try {
            const res = await window.fetch(
                `${CONFIG.OWM_URL}/weather?q=${encodeURIComponent(city)}&units=metric&appid=${CONFIG.OWM_KEY}`
            );
            if (!res.ok) throw new Error(`City not found`);
            const data = await res.json();
            STATE.location.name = data.name;
            STATE.location.country = data.sys?.country ?? '';
            STATE.location.lat = data.coord?.lat ?? STATE.location.lat;
            STATE.location.lon = data.coord?.lon ?? STATE.location.lon;
            await fetch(STATE.location.lat, STATE.location.lon);
            UIRenderer.showToast(`Location set to ${data.name}, ${data.sys?.country}`, 'success');
        } catch (err) {
            UIRenderer.showToast(`City not found: ${city}`, 'error');
        }
    }

    async function fetchByCoords(lat, lon) {
        const res = await window.fetch(`${CONFIG.OWM_URL}/weather?lat=${lat}&lon=${lon}&units=metric&appid=${CONFIG.OWM_KEY}`);
        const data = await res.json();
        STATE.location.name = data.name ?? 'Custom Location';
        STATE.location.country = data.sys?.country ?? '';
        STATE.location.lat = lat;
        STATE.location.lon = lon;
        await fetch(lat, lon);
    }

    return { fetch, fetchByCity, fetchByCoords, iconEmoji: _iconEmoji };
})();

// ============================================================
//  MODULE 4: PHYSICS MODULE
// ============================================================
const PhysicsModule = (() => {

    /** P_solar [MW] — Physics-based power model */
    function computeSolar(irradiance, tempC) {
        // P = Installed_capacity × (G/G_STC) × efficiency × temp_derating
        const gStc = 1000; // W/m² standard test condition
        const installed = CONFIG.SOLAR_PANEL_KWP;   // kWp
        const eta = CONFIG.SOLAR_EFFICIENCY;
        const tempDerate = 1 + CONFIG.SOLAR_TEMP_COEFF * Math.max(0, (tempC ?? 25) - 25);
        return Math.max(0, (installed * (irradiance / gStc) * eta * tempDerate) / 1000); // MW
    }

    /** P_wind [MW] — Cubic power curve model */
    function computeWind(windSpeed) {
        if (windSpeed < CONFIG.WIND_CUT_IN || windSpeed >= CONFIG.WIND_CUT_OUT) return 0;
        if (windSpeed >= CONFIG.WIND_RATED) return CONFIG.WIND_RATED_MW;

        // P = P_rated × ((v - v_cin)/(v_rated - v_cin))³
        const ratio = (windSpeed - CONFIG.WIND_CUT_IN) / (CONFIG.WIND_RATED - CONFIG.WIND_CUT_IN);
        return CONFIG.WIND_RATED_MW * Math.pow(ratio, 3);
    }

    /** Battery SOC update given net power flow and time step */
    function updateSOC(soc, netKW, dtSeconds) {
        const energyKWh = (netKW * dtSeconds) / 3600;
        const deltaSOC = (energyKWh / CONFIG.BATT_CAPACITY_KWH) * 100;
        return clamp(soc + deltaSOC, 0, 100);
    }

    /** Irradiance from cloud cover + hour */
    function irradianceProxy(cloudPct, hour, temp) {
        const peak = 1000;
        const hFac = Math.max(0, Math.sin(Math.PI * (hour - 6) / 12));
        const cFac = 1 - (cloudPct / 100) * 0.75;
        const tFac = 1 + CONFIG.SOLAR_TEMP_COEFF * Math.max(0, (temp ?? 25) - 25);
        return Math.max(0, peak * hFac * cFac * tFac);
    }

    /** Reserve margin calculation */
    function reserveMargin(totalAvailMW, peakLoadMW) {
        return ((totalAvailMW - peakLoadMW) / peakLoadMW) * 100;
    }

    /** CO2 savings in kg for given renewable generation (MW) over time step (s) */
    function co2Savings(solarMW, windMW, dtSeconds) {
        const solarKWh = (solarMW * 1000 * dtSeconds) / 3600;
        const windKWh = (windMW * 1000 * dtSeconds) / 3600;
        return (solarKWh + windKWh) * CONFIG.GRID_EMISSION_KG_PER_KWH;
    }

    return { computeSolar, computeWind, updateSOC, irradianceProxy, reserveMargin, co2Savings };
})();

// ============================================================
//  MODULE 5: AI ENGINE
// ============================================================
const AIEngine = (() => {

    /**
     * Main decision function — evaluates all rules and returns decision object.
     * Rules are evaluated in priority order:
     *   Critical Load > Battery Safety > Grid Duty > Solar/Wind Priority >
     *   EV Charging > Export > Demand Response
     */
    function evaluate() {
        const { power, battery, weather, fault, isIslandMode, drActive } = STATE;
        const { soc, health } = battery;
        const windSpeed = weather.windSpeed ?? 5;
        const solar = power.solar;
        const wind = power.wind;
        const load = power.load;
        const day = new Date().getDate();
        const isEvenDay = (day % 2 === 0);

        let pGen = solar + wind;
        let excess = pGen - load;
        power.totalGen = pGen;
        power.excess = excess;

        // ── Duty Cycle ─────────────────────────────────
        // Even day: Grid A charges battery, Grid B supplies load
        // Odd day:  Grid B charges battery, Grid A supplies load
        const chargeGrid = isEvenDay ? 'Grid A' : 'Grid B';
        const supplyGrid = isEvenDay ? 'Grid B' : 'Grid A';

        STATE.ai.dutyCycle = {
            day: day,
            charging: `${chargeGrid} charging`,
            priority: `${supplyGrid} → Load`,
            dr: drActive ? 'Active' : 'Normal',
        };

        // ── CRITICAL: Battery protection ─────────────────
        if (soc < CONFIG.BATT_SOC_CRITICAL) {
            return _makeDecision({
                case: 'CRIT-SOC',
                title: 'Critical: Battery Protection',
                desc: `SOC at ${soc.toFixed(0)}% — emergency mode. Other grid overriding to support. EV charging disabled.`,
                icon: '🚨',
                variant: 'critical',
                battMode: 'CHARGE',
                evOff: true,
                exportOff: true,
                alert: { level: 'critical', msg: `⚠️ CRITICAL: Battery SOC ${soc.toFixed(0)}% — Emergency support active. Secondary grid overriding.` },
            }, pGen, load, excess);
        }

        // ── Fault handling ────────────────────────────────
        if (fault.active) {
            return _handleFault(pGen, load, excess);
        }

        // ── Island mode ───────────────────────────────────
        if (isIslandMode) {
            return _makeDecision({
                case: 'ISLAND',
                title: 'Island Mode: Standalone Operation',
                desc: `Operating isolated from grid. Renewables + battery supplying ${load.toFixed(2)} MW load.`,
                icon: '🏝️',
                variant: excess > 0 ? 'success' : 'warning',
                battMode: excess > 0 ? 'CHARGE' : 'DISCHARGE',
                evOff: true,
                alert: excess < 0
                    ? { level: 'warning', msg: `Island Mode: Generation deficit ${Math.abs(excess).toFixed(2)} MW — battery discharging.` }
                    : { level: 'info', msg: `Island Mode active — ${excess.toFixed(2)} MW renewable surplus.` },
            }, pGen, load, excess);
        }

        // ── Demand Response ───────────────────────────────
        if (drActive && excess < -2) {
            const shedMW = Math.min(2, Math.abs(excess));
            return _makeDecision({
                case: 'DR',
                title: 'Demand Response: Load Shedding',
                desc: `Non-critical load shed by ${shedMW.toFixed(2)} MW to restore grid balance.`,
                icon: '⚡',
                variant: 'warning',
                battMode: 'DISCHARGE',
                alert: { level: 'warning', msg: `Demand Response active — ${shedMW.toFixed(2)} MW shed from non-critical loads.` },
            }, pGen, load, excess);
        }

        // ── Bad weather forecast reserve ──────────────────
        // Increase SOC reserve if bad weather predicted
        const minSOC = weather.badForecast ? CONFIG.BATT_SOC_RESERVE : CONFIG.BATT_SOC_MIN;

        // ── HIGH WIND (>10 m/s): Wind charges battery, Solar handles load
        if (windSpeed > 10 && !fault.active) {
            const windToBatt = Math.min(wind - load, CONFIG.BATT_MAX_KW / 1000);
            return _makeDecision({
                case: 'WIND-PRI',
                title: 'Wind Priority: High Wind Detected',
                desc: `Wind ${windSpeed.toFixed(1)} m/s > 10 m/s. Wind → Battery charging at ${Math.max(0, windToBatt).toFixed(2)} MW. Solar → Load supply.`,
                icon: '🌬️',
                variant: 'success',
                battMode: solar + Math.max(0, windToBatt) > 0.1 ? 'CHARGE' : 'IDLE',
                alert: { level: 'info', msg: `Wind Priority Mode: ${windSpeed.toFixed(1)} m/s — Wind routed to battery, Solar to load.` },
            }, solar /* not wind */, load, solar - load);
        }

        // ── HIGH SOLAR: Solar charges battery, Wind handles load
        const solarIrr = weather.irradiance ?? 0;
        if (solarIrr > 700 && wind > load * 0.6) {
            return _makeDecision({
                case: 'SOLAR-PRI',
                title: 'Solar Priority: High Irradiance',
                desc: `Irradiance ${solarIrr} W/m². Solar → Battery. Wind → Load.`,
                icon: '☀️',
                variant: 'success',
                battMode: 'CHARGE',
                alert: { level: 'info', msg: `Solar Priority Mode: High irradiance ${solarIrr} W/m².` },
            }, pGen, load, excess);
        }

        // ── SURPLUS: Generation > Load ───────────────────
        if (excess > 0) {
            const evOn = (soc > CONFIG.BATT_SOC_EV) && !isIslandMode;
            const exportOn = soc > 85;  // Multi-grid sharing

            if (evOn) {
                return _makeDecision({
                    case: 'SURPLUS-EV',
                    title: 'Surplus: EV Charging Active',
                    desc: `${excess.toFixed(2)} MW surplus. Load covered. Battery >70%. EV charging enabled.${exportOn ? ' Exporting to neighbor grid.' : ''}`,
                    icon: '⚡',
                    variant: 'success',
                    battMode: soc < CONFIG.BATT_SOC_MAX ? 'CHARGE' : 'IDLE',
                    exportOn,
                    alert: { level: 'info', msg: `Surplus ${excess.toFixed(2)} MW — EV charging active. SOC: ${soc.toFixed(0)}%.` },
                }, pGen, load, excess);
            }

            return _makeDecision({
                case: 'SURPLUS',
                title: 'Surplus: Charging Battery',
                desc: `${excess.toFixed(2)} MW surplus. Load served. Excess directed to battery storage. SOC: ${soc.toFixed(0)}%.`,
                icon: '🔋',
                variant: 'success',
                battMode: soc < CONFIG.BATT_SOC_MAX ? 'CHARGE' : 'IDLE',
                exportOn: exportOn,
                alert: { level: 'info', msg: `Surplus ${excess.toFixed(2)} MW — Battery charging. SOC: ${soc.toFixed(0)}%.` },
            }, pGen, load, excess);
        }

        // ── DEFICIT: Generation < Load ───────────────────
        if (excess < 0) {
            const deficit = Math.abs(excess);
            const battCanSupply = (soc > minSOC);

            if (!battCanSupply) {
                return _makeDecision({
                    case: 'DEFICIT-CRIT',
                    title: 'Deficit: Grid Support Required',
                    desc: `${deficit.toFixed(2)} MW deficit. Battery reserve at ${minSOC}%. Requesting external grid support.`,
                    icon: '⚠️',
                    variant: 'critical',
                    battMode: 'IDLE',
                    alert: { level: 'critical', msg: `Deficit ${deficit.toFixed(2)} MW — Battery reserve limit. Grid import required!` },
                }, pGen, load, excess);
            }

            return _makeDecision({
                case: 'DEFICIT',
                title: 'Deficit: Battery Discharging',
                desc: `${deficit.toFixed(2)} MW below demand. Battery discharging at ${Math.min(deficit, CONFIG.BATT_MAX_KW / 1000).toFixed(2)} MW.${weather.badForecast ? ' Reserve increased for forecast.' : ''
                    }`,
                icon: '🔻',
                variant: 'warning',
                battMode: 'DISCHARGE',
                alert: { level: 'warning', msg: `Deficit ${deficit.toFixed(2)} MW — Battery discharging. SOC: ${soc.toFixed(0)}%.` },
            }, pGen, load, excess);
        }

        // ── BALANCED ──────────────────────────────────────
        return _makeDecision({
            case: 'BALANCED',
            title: 'Balanced: System Nominal',
            desc: `Generation equals load demand (${pGen.toFixed(2)} MW). All systems operating nominally.`,
            icon: '✅',
            variant: 'success',
            battMode: 'IDLE',
            alert: { level: 'info', msg: 'System nominal — Generation balanced with load demand.' },
        }, pGen, load, excess);
    }

    function _handleFault(pGen, load, excess) {
        const { type } = STATE.fault;
        const typeMap = {
            A: { t: 'Grid A Failed', d: 'Grid A tripped. Load transferred to Grid B and battery backup.' },
            B: { t: 'Grid B Failed', d: 'Grid B tripped. Load transferred to Grid A and battery backup.' },
            both: { t: 'Total Blackout', d: 'Both grids failed. Island mode with battery only.' },
            battery: { t: 'Battery Fault', d: 'Battery disconnected from bus. Operating on renewables only.' },
        };
        const info = typeMap[type] ?? { t: 'Fault Active', d: 'Fault detected. Managing load.' };

        return _makeDecision({
            case: `FAULT-${type?.toUpperCase()}`,
            title: info.t,
            desc: info.d,
            icon: '🔴',
            variant: 'critical',
            battMode: type === 'battery' ? 'FAULT' : 'DISCHARGE',
            evOff: true,
            alert: { level: 'critical', msg: `⚠️ FAULT: ${info.t} — ${info.d}` },
        }, pGen, load, excess);
    }

    function _makeDecision({ case: caseId, title, desc, icon, variant, battMode, evOff, exportOn, exportOff, alert }) {
        const { power, battery } = STATE;
        const excess = power.excess;

        // Apply power routing
        power.ev = (evOff || !STATE.ev.active) ? 0 : CONFIG.EV_CHARGE_RATE_KW / 1000;
        power.export = (exportOn && !exportOff) ? Math.max(0, excess - power.ev) * 0.2 : 0;

        if (battMode === 'CHARGE') { power.battery = Math.min(excess, CONFIG.BATT_MAX_KW / 1000); }
        else if (battMode === 'DISCHARGE') { power.battery = -Math.min(Math.abs(excess), CONFIG.BATT_MAX_KW / 1000); }
        else { power.battery = 0; }

        battery.state = battMode === 'CHARGE' ? 'CHARGING'
            : battMode === 'DISCHARGE' ? 'DISCHARGING'
                : 'IDLE';

        // AI state update
        if (STATE.ai.case !== caseId) {
            addLog(`${title}: ${desc.substring(0, 80)}...`, variant === 'critical' ? 'critical' : variant === 'warning' ? 'warning' : 'success');
        }

        STATE.ai.case = caseId;
        STATE.ai.title = title;
        STATE.ai.desc = desc;
        STATE.ai.icon = icon;
        STATE.ai.variant = variant;

        if (alert) _setAlert(alert.level, alert.msg);

        return { caseId, title, desc, icon, variant, battMode };
    }

    function _setAlert(level, msg) {
        STATE._alertLevel = level;
        STATE._alertMsg = msg;
    }

    return { evaluate };
})();

// ============================================================
//  MODULE 6: SIMULATION MODULE
// ============================================================
const SimModule = (() => {
    let _tick = 0;

    /**
     * getSystemData() — Main data source function.
     * Replace this function's body with hardware reads for ESP32/Firebase.
     */
    function getSystemData() {
        if (STATE.mode === 'hardware') return HardwareModule.getData();
        return _getSimulatedData();
    }

    function _getSimulatedData() {
        _tick++;
        const hour = new Date().getHours();
        const noise = (mag) => (Math.random() - 0.5) * mag;

        const clouds = STATE.weather.clouds ?? 35;
        const windSpeed = STATE.weather.windSpeed ?? 5;
        const tempC = STATE.weather.temp ?? 28;

        // Compute physics-based generation
        const irr = PhysicsModule.irradianceProxy(clouds, hour, tempC);
        const solar = PhysicsModule.computeSolar(irr, tempC) + noise(0.3);
        const wind = PhysicsModule.computeWind(windSpeed) + noise(0.2);

        // Load follows a daily industrial pattern with noise
        const loadBase = _industrialLoadProfile(hour);
        const load = clamp(STATE.isAutoMode ? loadBase + noise(0.5) : STATE.power.load, 0.5, 15);

        STATE.weather.irradiance = Math.max(0, irr);

        return {
            solar: clamp(solar, 0, CONFIG.SOLAR_PANEL_KWP / 1000),
            wind: clamp(wind, 0, CONFIG.WIND_RATED_MW),
            load: STATE.isAutoMode ? load : STATE.power.load,
            windSpeed: windSpeed,
        };
    }

    function _industrialLoadProfile(hour) {
        const profile = {
            0: 5.5, 1: 5.2, 2: 5.0, 3: 5.0, 4: 5.1, 5: 5.5,
            6: 6.5, 7: 7.5, 8: 8.5, 9: 9.5, 10: 10.2, 11: 10.5,
            12: 10.0, 13: 10.3, 14: 10.8, 15: 11.0, 16: 10.5, 17: 9.8,
            18: 9.5, 19: 9.8, 20: 10.0, 21: 9.5, 22: 8.0, 23: 6.5,
        };
        return profile[hour] ?? 8;
    }

    return { getSystemData };
})();

// ============================================================
//  MODULE 7: HARDWARE MODULE (PLACEHOLDER)
// ============================================================
const HardwareModule = (() => {

    let _connected = false;
    let _firebaseUrl = '';
    let _lastData = null;

    /**
     * getData() — In hardware mode, this would fetch from Firebase RTDB.
     * Returns simulated fallback if Firebase not configured.
     */
    function getData() {
        // TODO: Replace with Firebase RTDB read
        // Example:
        //   const snap = await firebase.database().ref('/microgrid/live').get();
        //   const d = snap.val();
        //   return { solar: d.sensors.solar_power_kw / 1000, ... };
        return {
            solar: 0, wind: 0, load: CONFIG.LOAD_NOMINAL, windSpeed: 5,
            _source: 'hardware_placeholder',
        };
    }

    function tryConnect(fbUrl) {
        _firebaseUrl = fbUrl;
        UIRenderer.showToast('Hardware connection requires Firebase SDK + ESP32 firmware', 'warning', 5000);
        return false;
    }

    function isConnected() { return _connected; }

    return { getData, tryConnect, isConnected };
})();

// ============================================================
//  MODULE 8: UI RENDERER
// ============================================================
const UIRenderer = (() => {

    // ── DOM helpers ──
    const $ = (id) => document.getElementById(id);
    const set = (id, val) => { const e = $(id); if (e) e.textContent = val; };
    const setHTML = (id, html) => { const e = $(id); if (e) e.innerHTML = html; };

    function fmt(n, d = 2) { return (typeof n === 'number' && !isNaN(n)) ? n.toFixed(d) : '--'; }
    function pct(v, max) { return clamp((v / max) * 100, 0, 100); }

    // ── Clock ────────────────────────────────────────────────
    function updateClock() {
        const el = $('topbarClock');
        if (el) el.textContent = new Date().toLocaleTimeString('en-IN', { hour12: false });
    }

    // ── Stats Strip ──────────────────────────────────────────
    function updateStatsStrip() {
        const { weather, power, battery, ai, location } = STATE;

        set('statLocation', `${location.name}, ${location.country}`);
        set('statWeather', `${weather.temp ?? '--'} °C`);
        const wiEl = $('statWeatherIcon');
        if (wiEl) wiEl.textContent = WeatherModule.iconEmoji(weather.icon);

        set('statGeneration', `${fmt(power.totalGen)} MW`);
        set('statLoad', `${fmt(power.load)} MW`);
        set('statSOC', `${fmt(battery.soc, 0)}%`);

        const totalAvail = STATE.gridA.active ? CONFIG.GRID_A_MVA : 0
            + STATE.gridB.active ? CONFIG.GRID_B_MVA : 0
        + power.totalGen;
        const rm = PhysicsModule.reserveMargin(CONFIG.TOTAL_MVA + power.totalGen, power.load);
        set('statReserve', `${fmt(rm, 1)}%`);

        set('statCO2', `${fmt(STATE.carbon.totalKg, 1)} kg`);
        set('statAICase', ai.case || 'Initializing');
    }

    // ── Weather Card ─────────────────────────────────────────
    function updateWeather() {
        const w = STATE.weather;
        if (!w.temp) return;

        const xl = $('weatherIconXL'); if (xl) xl.textContent = WeatherModule.iconEmoji(w.icon);
        set('weatherTempBig', w.temp ?? '--');
        set('weatherDesc', w.condition);
        set('weatherBadge', (w.condition || '--').charAt(0).toUpperCase() + (w.condition || '').slice(1));

        set('wxWind', `${w.windSpeed} m/s`);
        set('wxHumidity', `${w.humidity} %`);
        set('wxClouds', `${w.clouds} %`);
        set('wxIrradiance', `${w.irradiance ?? 0} W/m²`);
        set('wxPressure', `${w.pressure} hPa`);
        set('wxVisibility', `${w.visibility} km`);

        set('weatherTimestamp', w.lastFetched ? `Updated: ${w.lastFetched}` : 'Not yet fetched');

        // Forecast chips
        const fr = $('forecastRow');
        if (fr && w.forecast.length) {
            fr.innerHTML = w.forecast.map(f =>
                `<div class="forecast-chip">
          <span class="fc-time">${f.time}</span>
          <span class="fc-icon">${f.icon}</span>
          <span class="fc-temp">${f.temp}°C</span>
          <span class="fc-wind">${f.wind} m/s</span>
        </div>`
            ).join('');
        }

        // Bad weather warning
        const bwWarn = $('badWeatherWarn');
        if (bwWarn) {
            bwWarn.style.display = w.badForecast ? 'flex' : 'none';
            set('badWeatherText', 'Bad weather forecast — SOC reserve target increased to 40%');
        }
    }

    // ── Energy Flow Card ─────────────────────────────────────
    function updateFlow() {
        const { power, gridA, gridB } = STATE;

        const maxMW = 12;

        set('fnSolarVal', `${fmt(power.solar)} MW`);
        set('fnWindVal', `${fmt(power.wind)} MW`);
        set('fnLoadVal', `${fmt(power.load)} MW`);
        set('fnBatteryVal', `${power.battery >= 0 ? '+' : ''}${fmt(power.battery)} MW`);
        set('fnEVVal', `${fmt(power.ev)} MW`);
        set('fnExportVal', `${fmt(power.export)} MW`);
        set('busTotalVal', `${fmt(power.totalGen)} MW`);

        // Progress bars in nodes
        _setBar('fnSolarBar', pct(power.solar, maxMW));
        _setBar('fnWindBar', pct(power.wind, maxMW));
        _setBar('fnLoadBar', pct(power.load, maxMW));

        // Grid node sub-labels
        _setNodeActive('fnGridA', !gridA.fault);
        _setNodeActive('fnGridB', !gridB.fault);
        set('fnGridASub', gridA.fault ? '⚠ FAULT' : isEvenDay() ? 'Charging' : 'Supplying');
        set('fnGridBSub', gridB.fault ? '⚠ FAULT' : isEvenDay() ? 'Supplying' : 'Charging');
        set('fnGridAVal', `${CONFIG.GRID_A_MVA} MVA`);
        set('fnGridBVal', `${CONFIG.GRID_B_MVA} MVA`);

        // Battery sub
        const battSub = $('fnBatterySub');
        if (battSub) {
            battSub.textContent = STATE.battery.state;
            battSub.className = `fn-sub ${STATE.battery.state === 'CHARGING' ? 'charging' : STATE.battery.state === 'DISCHARGING' ? 'discharging' : ''}`;
        }

        // EV sub
        set('fnEVSub', STATE.ev.active ? 'Charging' : 'Standby');

        // Flow mode indicator
        const dot = $('fmiDot'), txt = $('fmiText');
        if (STATE.fault.active) {
            if (dot) dot.className = 'fmi-dot fault';
            if (txt) txt.textContent = 'FAULT ACTIVE';
        } else if (STATE.isIslandMode) {
            if (dot) dot.className = 'fmi-dot island';
            if (txt) txt.textContent = 'Island Mode';
        } else {
            if (dot) dot.className = 'fmi-dot';
            if (txt) txt.textContent = 'Grid Connected';
        }

        // Grid mode pill
        const pill = $('gridModePill');
        const pillTxt = $('gridModeText');
        if (STATE.fault.active) {
            if (pill) pill.className = 'grid-mode-pill fault';
            if (pillTxt) pillTxt.textContent = `FAULT: Grid ${STATE.fault.type?.toUpperCase()}`;
        } else if (STATE.isIslandMode) {
            if (pill) pill.className = 'grid-mode-pill island';
            if (pillTxt) pillTxt.textContent = 'Island Mode';
        } else {
            if (pill) pill.className = 'grid-mode-pill';
            if (pillTxt) pillTxt.textContent = 'Grid-Connected';
        }

        // Power balance
        const exc = power.excess;
        set('pbGeneration', `${fmt(power.totalGen)} MW`);
        set('pbLoad', `${fmt(power.load)} MW`);
        const excEl = $('pbExcess');
        if (excEl) { excEl.textContent = `${exc >= 0 ? '+' : ''}${fmt(exc)} MW`; excEl.className = `pb-val ${exc >= 0 ? 'green-val' : 'red-val'}`; }

        const reserveMW = CONFIG.TOTAL_MVA + power.totalGen - power.load;
        const stability = STATE.fault.active ? 'FAULT' : reserveMW > 2 ? 'Stable' : reserveMW > 0 ? 'Marginal' : 'Unstable';
        const stabEl = $('pbStability');
        if (stabEl) { stabEl.textContent = stability; stabEl.className = `pb-val ${stability === 'Stable' ? 'green-val' : stability === 'Marginal' ? 'amber-val' : 'red-val'}`; }

        // Animated flow lines
        _drawFlowLines();
    }

    function _setBar(id, pct) {
        const el = document.getElementById(id);
        if (el) el.style.width = pct + '%';
    }

    function _setNodeActive(id, active) {
        const el = document.getElementById(id);
        if (el) {
            el.classList.toggle('active', active);
            el.classList.toggle('fault-node', !active);
        }
    }

    function _drawFlowLines() {
        const svg = $('flowSVG');
        if (!svg) return;

        // Remove old lines
        svg.querySelectorAll('.flow-line').forEach(l => l.remove());

        const diag = $('flowDiagram');
        if (!diag) return;
        const dRect = diag.getBoundingClientRect();

        const hub = _hubCenter(dRect);
        if (!hub) return;

        const connections = [
            { nodeId: 'fnSolar', toHub: true, active: STATE.power.solar > 0.1, cls: 'fl-source' },
            { nodeId: 'fnWind', toHub: true, active: STATE.power.wind > 0.1, cls: 'fl-source' },
            { nodeId: 'fnGridA', toHub: true, active: !STATE.gridA.fault && !STATE.isIslandMode, cls: STATE.gridA.fault ? 'fl-fault' : 'fl-source' },
            { nodeId: 'fnGridB', toHub: true, active: !STATE.gridB.fault && !STATE.isIslandMode, cls: STATE.gridB.fault ? 'fl-fault' : 'fl-source' },
            { nodeId: 'fnLoad', toHub: false, active: STATE.power.load > 0.1, cls: 'fl-sink' },
            { nodeId: 'fnBattery', toHub: STATE.power.battery < 0, active: Math.abs(STATE.power.battery) > 0.1, cls: 'fl-batt' },
            { nodeId: 'fnEV', toHub: false, active: STATE.power.ev > 0.01, cls: 'fl-ev' },
            { nodeId: 'fnExport', toHub: false, active: STATE.power.export > 0.01, cls: 'fl-sink' },
        ];

        connections.forEach(({ nodeId, toHub, active, cls }) => {
            if (!active) return;
            const nodeEl = $(nodeId);
            if (!nodeEl) return;
            const nRect = nodeEl.getBoundingClientRect();
            const nc = { x: nRect.left - dRect.left + nRect.width / 2, y: nRect.top - dRect.top + nRect.height / 2 };

            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.setAttribute('x1', toHub ? nc.x : hub.x);
            line.setAttribute('y1', toHub ? nc.y : hub.y);
            line.setAttribute('x2', toHub ? hub.x : nc.x);
            line.setAttribute('y2', toHub ? hub.y : nc.y);
            line.setAttribute('class', `flow-line ${cls}`);
            svg.insertBefore(line, svg.firstChild);
        });
    }

    function _hubCenter(dRect) {
        const hub = document.querySelector('.bus-hub-inner');
        if (!hub) return null;
        const r = hub.getBoundingClientRect();
        return { x: r.left - dRect.left + r.width / 2, y: r.top - dRect.top + r.height / 2 };
    }

    // ── Battery Card ─────────────────────────────────────────
    function updateBattery() {
        const { soc, voltage, current, temp, state, health, etaHours } = STATE.battery;

        const arc = $('socArc');
        if (arc) {
            const circ = 263.9;
            const offset = circ - (soc / 100) * circ;
            arc.style.strokeDashoffset = offset;
            // Color by SOC level
            arc.style.stroke =
                soc < 20 ? '#EF4444' :
                    soc < 40 ? '#F59E0B' :
                        soc > 90 ? '#F59E0B' : '#2563EB';
        }

        set('socVal', fmt(soc, 0));
        set('socState', state);

        set('bsVoltage', `${fmt(voltage, 1)} V`);
        set('bsCurrent', `${fmt(Math.abs(current), 1)} A`);
        set('bsPower', `${fmt(Math.abs(STATE.power.battery * 1000), 1)} kW`);
        set('bsTemp', `${fmt(temp, 1)} °C`);

        if (etaHours && etaHours > 0) {
            const h = Math.floor(etaHours), m = Math.round((etaHours - h) * 60);
            set('bsETA', `${h}h ${m}m`);
        } else { set('bsETA', '—'); }

        // SOC threshold cursor
        const cursor = $('stbCursor');
        if (cursor) {
            cursor.style.left = `${soc}%`;
            cursor.style.background =
                soc < 20 ? '#EF4444' : soc > 90 ? '#F59E0B' : '#2563EB';
        }

        // Battery badge
        const badge = $('battBadge');
        if (badge) {
            if (soc < 20) { badge.textContent = 'CRITICAL'; badge.className = 'card-badge badge-red'; }
            else if (soc < 40) { badge.textContent = 'LOW'; badge.className = 'card-badge badge-amber'; }
            else if (soc > 90) { badge.textContent = 'FULL'; badge.className = 'card-badge badge-amber'; }
            else { badge.textContent = 'GOOD'; badge.className = 'card-badge badge-green'; }
        }

        // Health
        const hFill = $('bhFill'); if (hFill) hFill.style.width = health + '%';
        set('bhVal', `${health}%`);

        // Grid capacity rings
        _updateGridCard('A');
        _updateGridCard('B');
    }

    function _updateGridCard(g) {
        const grid = g === 'A' ? STATE.gridA : STATE.gridB;
        const cap = g === 'A' ? CONFIG.GRID_A_MVA : CONFIG.GRID_B_MVA;
        const circ = 207.3;
        const pct = clamp(grid.outputMW / cap, 0, 1);
        const arc = $(`grid${g}Arg`);
        if (arc) {
            arc.style.strokeDashoffset = circ - pct * circ;
            arc.style.stroke = grid.fault ? '#EF4444' : g === 'A' ? '#10B981' : '#2563EB';
        }
        set(`grid${g}Load`, fmt(pct * 100, 0));
        set(`grid${g}Output`, `${fmt(grid.outputMW, 2)} MW`);
        set(`grid${g}Mode`, grid.fault ? 'FAULT' : grid.mode);
        set(`grid${g}Freq`, `${fmt(grid.freq, 1)} Hz`);
        set(`grid${g}Voltage`, `${fmt(grid.voltage, 1)} kV`);
        set(`grid${g}PF`, `${fmt(grid.pf, 2)}`);

        const stFill = $(`grid${g}StabilityFill`);
        if (stFill) {
            stFill.style.width = grid.stability + '%';
            stFill.className = `sb-fill ${g === 'B' ? 'sb-blue' : ''} ${grid.fault ? 'fault-bar' : ''}`;
        }
        set(`grid${g}StabilityVal`, `${grid.stability}%`);

        const badge = $(`grid${g}Badge`);
        if (badge) {
            if (grid.fault) { badge.textContent = 'FAULT'; badge.className = 'card-badge badge-red'; }
            else if (grid.mode === 'Charging') { badge.textContent = 'CHARGING'; badge.className = 'card-badge badge-blue'; }
            else { badge.textContent = 'ACTIVE'; badge.className = 'card-badge badge-green'; }
        }
    }

    // ── AI Panel ─────────────────────────────────────────────
    function updateAI() {
        const ai = STATE.ai;
        const { power, battery, weather, isIslandMode, drActive } = STATE;

        // Active case block
        const block = $('aiActiveBlock');
        if (block) {
            block.className = `ai-active-block ${ai.variant === 'critical' ? 'case-critical' :
                ai.variant === 'warning' ? 'case-warning' :
                    ai.variant === 'success' ? 'case-success' : ''
                }`;
        }

        set('aiIcon', ai.icon);
        set('aiCaseTitle', ai.title);
        set('aiCaseDesc', ai.desc);

        const caseBadge = $('aiCaseBadge');
        if (caseBadge) {
            caseBadge.textContent = ai.case || '--';
            caseBadge.className = `card-badge ${ai.variant === 'critical' ? 'badge-red' :
                ai.variant === 'warning' ? 'badge-amber' :
                    ai.variant === 'success' ? 'badge-green' : 'badge-purple'
                }`;
        }

        // Condition pills
        const conditions = [
            { label: `Gen (${fmt(power.totalGen)} MW) > Load (${fmt(power.load)} MW)`, state: power.excess > 0 ? 'met' : 'unmet' },
            { label: `SOC ${fmt(battery.soc, 0)}% > Critical 20%`, state: battery.soc > 20 ? 'met' : 'critical' },
            { label: `Wind ${(weather.windSpeed ?? 0).toFixed(1)} m/s > 10 m/s`, state: (weather.windSpeed ?? 0) > 10 ? 'met' : 'unmet' },
            { label: `SOC > 70% (EV Enable)`, state: battery.soc > 70 ? 'met' : 'unmet' },
            { label: `Island Mode`, state: isIslandMode ? 'warn' : 'unmet' },
            { label: `Demand Response`, state: drActive ? 'warn' : 'unmet' },
            { label: `Bad Weather Forecast`, state: weather.badForecast ? 'warn' : 'unmet' },
            { label: `Fault Active`, state: STATE.fault.active ? 'critical' : 'unmet' },
        ];

        const condEl = $('aiConditions');
        if (condEl) {
            condEl.innerHTML = conditions.map(c =>
                `<div class="ai-pill ${c.state}">
          <span class="ai-pill-dot"></span>${c.label}
        </div>`
            ).join('');
        }

        // Duty cycle
        const dc = ai.dutyCycle;
        set('dcDay', dc.day ? `Day ${dc.day} (${dc.day % 2 === 0 ? 'Even' : 'Odd'})` : '--');
        set('dcCharging', dc.charging || '--');
        set('dcPriority', dc.priority || '--');
        set('dcDR', dc.dr || '--');

        // Log
        _renderLog();
    }

    function _renderLog() {
        const container = $('logScroll');
        if (!container) return;
        container.innerHTML = STATE.ai.log.slice(0, 20).map(e =>
            `<div class="log-entry ${e.level}">
        <span class="le-time">${e.time}</span>
        <span class="le-msg">${e.msg}</span>
      </div>`
        ).join('');
    }

    // ── EV Card ──────────────────────────────────────────────
    function updateEV() {
        const ev = STATE.ev;
        const excPos = STATE.power.excess > 0;
        const socOK = STATE.battery.soc > CONFIG.BATT_SOC_EV;
        const notIsl = !STATE.isIslandMode;

        // Condition dots
        _setEVDot('evcDot1', excPos ? 'met' : 'unmet');
        _setEVDot('evcDot2', socOK ? 'met' : 'unmet');
        _setEVDot('evcDot3', notIsl ? 'met' : 'warning');

        // State
        const badge = $('evBadge');
        if (ev.active && STATE.relays?.ev !== false) {
            set('evState', 'Charging');
            set('evRate', `${fmt(ev.chargeRateKW, 1)} kW`);
            if (badge) { badge.textContent = 'CHARGING'; badge.className = 'card-badge badge-green'; }
            const bolt = $('evBoltAnim');
            if (bolt) bolt.classList.add('active');
        } else {
            set('evState', socOK && excPos ? 'Ready' : 'Standby');
            set('evRate', '0.0 kW');
            if (badge) { badge.textContent = socOK && excPos ? 'READY' : 'STANDBY'; badge.className = `card-badge ${socOK && excPos ? 'badge-blue' : 'badge-gray'}`; }
            const bolt = $('evBoltAnim');
            if (bolt) bolt.classList.remove('active');
        }

        set('evBattPct', `${fmt(ev.battPct, 0)}%`);
        set('evSessionE', `${fmt(ev.sessionKWh, 2)} kWh`);
        set('evETA', ev.etaMin ? `${Math.round(ev.etaMin)} min` : '--');
        set('evQueue', `${ev.queue} vehicle${ev.queue === 1 ? '' : 's'}`);

        const fill = $('evBarFill');
        if (fill) fill.style.width = `${ev.battPct}%`;
        set('evBarLabel', `EV: ${fmt(ev.battPct, 0)}%`);
    }

    function _setEVDot(id, state) {
        const el = $(id);
        if (el) el.className = `evc-dot ${state}`;
    }

    // ── Carbon ───────────────────────────────────────────────
    function updateCarbon() {
        const c = STATE.carbon;
        set('carbonBig', fmt(c.totalKg, 1));
        set('statCO2', `${fmt(c.totalKg, 1)} kg`);
        set('cbSolar', `${fmt(c.solarKg, 1)} kg`);
        set('cbWind', `${fmt(c.windKg, 1)} kg`);
        set('ceTree', `${(c.totalKg / 21.77).toFixed(2)} trees/day`);
        set('ceCar', `${(c.totalKg / 0.21).toFixed(0)} km offset`);

        // 12h load forecast bars
        _renderForecastBars();
    }

    function _renderForecastBars() {
        const el = $('loadForecastBars');
        if (!el) return;
        const hours = Array.from({ length: 12 }, (_, i) => (new Date().getHours() + i) % 24);
        const profiles = {
            0: 5.5, 1: 5.2, 2: 5.0, 3: 5.0, 4: 5.1, 5: 5.5, 6: 6.5, 7: 7.5, 8: 8.5, 9: 9.5,
            10: 10.2, 11: 10.5, 12: 10.0, 13: 10.3, 14: 10.8, 15: 11.0, 16: 10.5, 17: 9.8,
            18: 9.5, 19: 9.8, 20: 10.0, 21: 9.5, 22: 8.0, 23: 6.5,
        };
        const maxP = 12;
        el.innerHTML = hours.map(h => {
            const p = profiles[h] ?? 8;
            const pctH = (p / maxP) * 100;
            return `<div class="lf-bar-wrap">
        <div class="lf-val">${p.toFixed(1)}</div>
        <div class="lf-bar-track">
          <div class="lf-bar-fill" style="height:${pctH}%"></div>
        </div>
        <div class="lf-label">${String(h).padStart(2, '0')}:00</div>
      </div>`;
        }).join('');
    }

    // ── Alert Banner ─────────────────────────────────────────
    function setAlert(level, msg) {
        const banner = $('alertBanner');
        const inner = $('alertInner');
        const msgEl = $('alertMsg');
        const iconEl = $('alertIcon');
        if (!banner) return;

        if (level === 'clear') { banner.style.maxHeight = '0'; banner.style.padding = '0'; return; }

        banner.style.maxHeight = '52px';
        banner.className = `alert-banner ${level === 'info' ? '' : level}`;

        const icons = { info: 'ℹ️', warning: '⚠️', critical: '🚨', success: '✅', error: '🔴' };
        if (iconEl) iconEl.textContent = icons[level] ?? 'ℹ️';
        if (msgEl) msgEl.textContent = msg;
    }

    // ── Toast ─────────────────────────────────────────────────
    function showToast(msg, type = 'info', duration = 3500) {
        const container = $('toastContainer');
        if (!container) return;
        const icons = { info: '📡', success: '✅', warning: '⚠️', error: '🔴' };
        const t = document.createElement('div');
        t.className = `toast ${type}`;
        t.innerHTML = `<span>${icons[type]}</span><span>${msg}</span>`;
        container.appendChild(t);
        setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, duration);
    }

    // ── Live Indicator ────────────────────────────────────────
    function setLiveIndicator(live) {
        const dot = $('modeStatusDot');
        if (dot) dot.className = `mode-status-dot ${live ? 'sim' : 'disconnected'}`;
    }

    // ── Fault UI ──────────────────────────────────────────────
    function updateFaultUI() {
        const { fault } = STATE;
        const indicator = document.querySelector('.fs-dot');
        if (indicator) indicator.className = `fs-dot ${fault.active ? 'fault' : 'nominal'}`;
        set('fsText', fault.active ? `Fault: Grid ${fault.type?.toUpperCase()} active` : 'System Nominal');

        const actions = $('fsActions');
        if (actions) actions.style.display = fault.active ? 'block' : 'none';

        const activeBadge = $('faultActiveBadge');
        if (activeBadge) activeBadge.style.display = fault.active ? 'inline-flex' : 'none';

        // Fault log
        const flog = $('faultLog');
        if (flog) {
            flog.innerHTML = fault.events.slice(-3).reverse().map(e =>
                `<div class="fault-log-entry">⚡ ${e.time} — ${e.msg}</div>`
            ).join('');
        }
    }

    return {
        updateClock, updateStatsStrip, updateWeather, updateFlow,
        updateBattery, updateAI, updateEV, updateCarbon,
        setAlert, showToast, setLiveIndicator, updateFaultUI,
    };
})();

// ============================================================
//  MODULE 9: CHART MODULE
// ============================================================
const ChartModule = (() => {

    let _genCtx = null, _socCtx = null;

    function init() {
        const genCanvas = document.getElementById('genLoadChart');
        const socCanvas = document.getElementById('socChart');
        if (genCanvas) _genCtx = genCanvas.getContext('2d');
        if (socCanvas) _socCtx = socCanvas.getContext('2d');
    }

    function update() {
        const time = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
        const { chart, power, battery } = STATE;

        chart.labels.push(time);
        chart.solar.push(parseFloat(power.solar.toFixed(2)));
        chart.wind.push(parseFloat(power.wind.toFixed(2)));
        chart.load.push(parseFloat(power.load.toFixed(2)));
        chart.soc.push(parseFloat(battery.soc.toFixed(1)));

        // Keep max history
        const max = CONFIG.CHART_HISTORY;
        ['labels', 'solar', 'wind', 'load', 'soc'].forEach(k => {
            if (chart[k].length > max) chart[k].shift();
        });

        if (_genCtx) _drawGenLoad(_genCtx);
        if (_socCtx) _drawSOC(_socCtx);
    }

    function _drawGenLoad(ctx) {
        const canvas = ctx.canvas;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = canvas.offsetWidth * dpr;
        canvas.height = canvas.offsetHeight * dpr;
        ctx.scale(dpr, dpr);
        const W = canvas.offsetWidth, H = canvas.offsetHeight;
        ctx.clearRect(0, 0, W, H);

        const pad = { t: 10, r: 10, b: 28, l: 36 };
        const cW = W - pad.l - pad.r;
        const cH = H - pad.t - pad.b;
        const pts = STATE.chart.labels.length;
        if (pts < 2) return;

        const maxV = 14;

        // Grid lines
        ctx.strokeStyle = '#F3F4F6';
        ctx.lineWidth = 1;
        for (let i = 0; i <= 4; i++) {
            const y = pad.t + (i / 4) * cH;
            ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
            ctx.fillStyle = '#9CA3AF'; ctx.font = '9px Inter,sans-serif'; ctx.textAlign = 'right';
            ctx.fillText((maxV - (maxV / 4) * i).toFixed(0) + 'M', pad.l - 4, y + 3);
        }

        // X labels (every 4th)
        ctx.fillStyle = '#9CA3AF'; ctx.font = '9px Inter,sans-serif'; ctx.textAlign = 'center';
        STATE.chart.labels.forEach((l, i) => {
            if (i % 4 === 0) ctx.fillText(l, pad.l + (i / (pts - 1)) * cW, H - 4);
        });

        const drawLine = (data, color, fill) => {
            if (data.length < 2) return;
            const xOf = (i) => pad.l + (i / (pts - 1)) * cW;
            const yOf = (v) => pad.t + cH - (v / maxV) * cH;

            ctx.beginPath();
            data.forEach((v, i) => { i === 0 ? ctx.moveTo(xOf(i), yOf(v)) : ctx.lineTo(xOf(i), yOf(v)); });

            if (fill) {
                ctx.lineTo(xOf(pts - 1), pad.t + cH);
                ctx.lineTo(xOf(0), pad.t + cH);
                ctx.closePath();
                const g = ctx.createLinearGradient(0, pad.t, 0, pad.t + cH);
                g.addColorStop(0, fill + '30'); g.addColorStop(1, fill + '00');
                ctx.fillStyle = g; ctx.fill();
            }

            ctx.beginPath();
            data.forEach((v, i) => { i === 0 ? ctx.moveTo(xOf(i), yOf(v)) : ctx.lineTo(xOf(i), yOf(v)); });
            ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
        };

        drawLine(STATE.chart.load, '#F59E0B', '#F59E0B');
        drawLine(STATE.chart.wind, '#2563EB', '#2563EB');
        drawLine(STATE.chart.solar, '#10B981', '#10B981');
    }

    function _drawSOC(ctx) {
        const canvas = ctx.canvas;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = canvas.offsetWidth * dpr;
        canvas.height = canvas.offsetHeight * dpr;
        ctx.scale(dpr, dpr);
        const W = canvas.offsetWidth, H = canvas.offsetHeight;
        ctx.clearRect(0, 0, W, H);

        const pad = { t: 10, r: 10, b: 28, l: 36 };
        const cW = W - pad.l - pad.r, cH = H - pad.t - pad.b;
        const pts = STATE.chart.soc.length;
        if (pts < 2) return;

        const maxV = 100;

        // Zones
        ctx.fillStyle = 'rgba(239,68,68,0.06)';
        ctx.fillRect(pad.l, pad.t + cH * 0.8, cW, cH * 0.2);
        ctx.fillStyle = 'rgba(245,158,11,0.04)';
        ctx.fillRect(pad.l, pad.t, cW, cH * 0.1);

        // Grid
        ctx.strokeStyle = '#F3F4F6'; ctx.lineWidth = 1;
        [20, 40, 60, 80, 100].forEach(v => {
            const y = pad.t + cH - (v / 100) * cH;
            ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
            ctx.fillStyle = '#9CA3AF'; ctx.font = '9px Inter,sans-serif'; ctx.textAlign = 'right';
            ctx.fillText(v + '%', pad.l - 4, y + 3);
        });

        // Target line at 70%
        const tY = pad.t + cH - (70 / 100) * cH;
        ctx.setLineDash([4, 4]); ctx.strokeStyle = 'rgba(16,185,129,0.4)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(pad.l, tY); ctx.lineTo(W - pad.r, tY); ctx.stroke();
        ctx.setLineDash([]);

        // SOC line
        const xOf = (i) => pad.l + (i / (pts - 1)) * cW;
        const yOf = (v) => pad.t + cH - (v / maxV) * cH;

        ctx.beginPath();
        STATE.chart.soc.forEach((v, i) => { i === 0 ? ctx.moveTo(xOf(i), yOf(v)) : ctx.lineTo(xOf(i), yOf(v)); });
        ctx.lineTo(xOf(pts - 1), pad.t + cH);
        ctx.lineTo(xOf(0), pad.t + cH);
        ctx.closePath();
        const g = ctx.createLinearGradient(0, pad.t, 0, pad.t + cH);
        g.addColorStop(0, 'rgba(37,99,235,0.25)');
        g.addColorStop(1, 'rgba(37,99,235,0.00)');
        ctx.fillStyle = g; ctx.fill();

        ctx.beginPath();
        STATE.chart.soc.forEach((v, i) => { i === 0 ? ctx.moveTo(xOf(i), yOf(v)) : ctx.lineTo(xOf(i), yOf(v)); });
        ctx.strokeStyle = '#2563EB'; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.stroke();

        // X labels
        ctx.fillStyle = '#9CA3AF'; ctx.font = '9px Inter,sans-serif'; ctx.textAlign = 'center';
        STATE.chart.labels.forEach((l, i) => {
            if (i % 4 === 0) ctx.fillText(l, xOf(i), H - 6);
        });
    }

    return { init, update };
})();

// ============================================================
//  MODULE 10: CONTROLS
// ============================================================
function initControls() {
    // Sliders
    const sliders = [
        { id: 'loadSlider', valId: 'loadSliderVal', fn: v => { STATE.power.load = parseFloat(v); return `${parseFloat(v).toFixed(1)} MW`; } },
        { id: 'windSlider', valId: 'windSliderVal', fn: v => { STATE.weather.windSpeed = parseFloat(v); return `${parseFloat(v).toFixed(1)} m/s`; } },
        { id: 'cloudSlider', valId: 'cloudSliderVal', fn: v => { STATE.weather.clouds = parseInt(v); return `${v}%`; } },
        { id: 'socSlider', valId: 'socSliderVal', fn: v => { STATE.battery.soc = parseFloat(v); return `${parseFloat(v).toFixed(0)}%`; } },
        { id: 'tempSlider', valId: 'tempSliderVal', fn: v => { STATE.weather.temp = parseInt(v); return `${v}°C`; } },
    ];

    sliders.forEach(({ id, valId, fn }) => {
        const el = document.getElementById(id);
        const ve = document.getElementById(valId);
        if (!el) return;
        el.addEventListener('input', () => {
            if (ve) ve.textContent = fn(el.value);
            STATE.isAutoMode = false;
        });
    });

    // City search
    const cityInput = document.getElementById('cityInput');
    const searchBtn = document.getElementById('searchBtn');
    const suggestions = document.getElementById('searchSuggestions');

    if (searchBtn && cityInput) {
        const doSearch = () => {
            const city = cityInput.value.trim();
            if (city.length < 2) { UIRenderer.showToast('Enter a valid city name', 'warning'); return; }
            if (suggestions) { suggestions.classList.remove('visible'); suggestions.innerHTML = ''; }
            WeatherModule.fetchByCity(city);
        };

        searchBtn.addEventListener('click', doSearch);
        cityInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

        // Quick suggestions from popular cities
        const popularCities = [
            { name: 'Asansol', country: 'IN', flag: '🇮🇳' },
            { name: 'Mumbai', country: 'IN', flag: '🇮🇳' },
            { name: 'Delhi', country: 'IN', flag: '🇮🇳' },
            { name: 'London', country: 'GB', flag: '🇬🇧' },
            { name: 'New York', country: 'US', flag: '🇺🇸' },
            { name: 'Tokyo', country: 'JP', flag: '🇯🇵' },
            { name: 'Dubai', country: 'AE', flag: '🇦🇪' },
            { name: 'Sydney', country: 'AU', flag: '🇦🇺' },
            { name: 'Berlin', country: 'DE', flag: '🇩🇪' },
            { name: 'Singapore', country: 'SG', flag: '🇸🇬' },
        ];

        cityInput.addEventListener('focus', () => {
            if (cityInput.value.length === 0 && suggestions) {
                suggestions.innerHTML = popularCities.map(c =>
                    `<div class="suggestion-item" onclick="selectCity('${c.name}')">
            <span class="suggestion-flag">${c.flag}</span>
            <span>${c.name}, ${c.country}</span>
          </div>`
                ).join('');
                suggestions.classList.add('visible');
            }
        });

        cityInput.addEventListener('input', () => {
            if (cityInput.value.length === 0 && suggestions) suggestions.classList.remove('visible');
        });

        document.addEventListener('click', e => {
            if (suggestions && !e.target.closest('#locationSearchWrap')) {
                suggestions.classList.remove('visible');
            }
        });
    }

    // Geolocation
    const geoBtn = document.getElementById('geoBtn');
    if (geoBtn) {
        geoBtn.addEventListener('click', () => {
            if (!navigator.geolocation) { UIRenderer.showToast('Geolocation not supported', 'error'); return; }
            UIRenderer.showToast('Fetching your location...', 'info', 2000);
            navigator.geolocation.getCurrentPosition(
                pos => WeatherModule.fetchByCoords(pos.coords.latitude, pos.coords.longitude),
                () => UIRenderer.showToast('Location access denied', 'error')
            );
        });
    }

    // Mode toggle (Simulation ↔ Hardware)
    const modeBtn = document.getElementById('modeToggleBtn');
    if (modeBtn) {
        modeBtn.addEventListener('click', () => {
            if (STATE.mode === 'simulation') {
                STATE.mode = 'hardware';
                document.getElementById('hwOverlay').style.display = 'flex';
                const thumb = document.getElementById('toggleThumb');
                const track = modeBtn.querySelector('.toggle-track');
                if (thumb) thumb.classList.add('right');
                if (track) track.classList.add('active-hw');
                const dot = document.getElementById('modeStatusDot');
                const label = document.getElementById('modeLabel');
                if (dot) dot.className = 'mode-status-dot disconnected';
                if (label) label.textContent = 'Hardware';
                modeBtn.setAttribute('aria-checked', 'true');
            } else {
                switchToSimulation();
            }
        });
    }
}

function selectCity(city) {
    const inp = document.getElementById('cityInput');
    if (inp) inp.value = city;
    const sug = document.getElementById('searchSuggestions');
    if (sug) { sug.classList.remove('visible'); sug.innerHTML = ''; }
    WeatherModule.fetchByCity(city);
}

function switchToSimulation() {
    STATE.mode = 'simulation';
    document.getElementById('hwOverlay').style.display = 'none';
    const thumb = document.getElementById('toggleThumb');
    const track = document.querySelector('.toggle-track');
    if (thumb) thumb.classList.remove('right');
    if (track) track.classList.remove('active-hw');
    const dot = document.getElementById('modeStatusDot');
    const label = document.getElementById('modeLabel');
    if (dot) dot.className = 'mode-status-dot sim';
    if (label) label.textContent = 'Simulation';
    const btn = document.getElementById('modeToggleBtn');
    if (btn) btn.setAttribute('aria-checked', 'false');
    UIRenderer.showToast('Switched to Simulation Mode', 'info');
}

function connectHardware() {
    const url = document.getElementById('hwFirebaseUrl')?.value?.trim();
    HardwareModule.tryConnect(url);
}

function toggleAuto() {
    STATE.isAutoMode = !STATE.isAutoMode;
    const btn = document.getElementById('autoToggle');
    const track = btn?.querySelector('.tm-track');
    if (track) track.className = `tm-track ${STATE.isAutoMode ? 'on' : ''}`;
    UIRenderer.showToast(`Auto mode ${STATE.isAutoMode ? 'ON' : 'OFF'}`, 'info', 2000);
}

function toggleIslandMode() {
    STATE.isIslandMode = !STATE.isIslandMode;
    const btn = document.getElementById('islandModeBtn');
    if (btn) btn.classList.toggle('active', STATE.isIslandMode);
    UIRenderer.showToast(`Island Mode ${STATE.isIslandMode ? 'activated' : 'deactivated'}`, STATE.isIslandMode ? 'warning' : 'info');
    addLog(`Island Mode ${STATE.isIslandMode ? 'ACTIVATED' : 'deactivated'}`, STATE.isIslandMode ? 'warning' : 'info');
}

function triggerDemandResponse() {
    STATE.drActive = !STATE.drActive;
    const btn = document.getElementById('drBtn');
    if (btn) btn.style.background = STATE.drActive ? '#DC2626' : '';
    UIRenderer.showToast(`Demand Response ${STATE.drActive ? 'triggered' : 'cleared'}`, STATE.drActive ? 'warning' : 'info');
    addLog(`Demand Response ${STATE.drActive ? 'ACTIVE — non-critical load shedding' : 'deactivated'}`, 'warning');
}

function simulateFault(type) {
    STATE.fault.active = true;
    STATE.fault.type = type;

    const faultMsg = {
        A: 'Grid A failure — Load transferred to Grid B + battery',
        B: 'Grid B failure — Load transferred to Grid A + battery',
        both: 'Total blackout — Island mode engaged, battery backup only',
        battery: 'Battery fault — Battery disconnected, renewables only',
    };

    const msg = faultMsg[type] ?? 'Fault simulated';
    STATE.fault.events.push({ time: new Date().toLocaleTimeString('en-IN', { hour12: false }), msg });

    // Apply grid state changes
    if (type === 'A' || type === 'both') {
        STATE.gridA.fault = true;
        STATE.gridA.active = false;
        STATE.gridA.stability = 0;
    }
    if (type === 'B' || type === 'both') {
        STATE.gridB.fault = true;
        STATE.gridB.active = false;
        STATE.gridB.stability = 0;
    }
    if (type === 'both') STATE.isIslandMode = true;
    if (type === 'battery') {
        STATE.battery.state = 'FAULT';
        STATE.power.battery = 0;
    }

    // Highlight active fault button
    ['A', 'B', 'both', 'battery'].forEach(t => {
        const b = document.getElementById(`btnFault${t === 'A' ? 'GridA' : t === 'B' ? 'GridB' : t === 'both' ? 'Both' : 'Batt'}`);
        if (b) b.classList.toggle('active', t === type);
    });

    UIRenderer.showToast(`⚠️ FAULT: ${msg}`, 'error', 6000);
    addLog(`FAULT SIMULATED: ${msg}`, 'critical');
    UIRenderer.setAlert('critical', `⚠️ FAULT: ${msg}`);
    UIRenderer.updateFaultUI();
}

function clearFault() {
    STATE.fault.active = false;
    STATE.fault.type = null;
    STATE.gridA.fault = false; STATE.gridA.active = true; STATE.gridA.stability = 95;
    STATE.gridB.fault = false; STATE.gridB.active = true; STATE.gridB.stability = 92;
    STATE.isIslandMode = false;
    STATE.battery.state = 'IDLE';

    ['btnFaultGridA', 'btnFaultGridB', 'btnFaultBoth', 'btnFaultBatt'].forEach(id => {
        const b = document.getElementById(id); if (b) b.classList.remove('active');
    });

    UIRenderer.showToast('Fault cleared — System restored to normal', 'success');
    addLog('All faults cleared — System restored nominally', 'success');
    UIRenderer.updateFaultUI();
}

function dismissAlert() {
    const banner = document.getElementById('alertBanner');
    if (banner) { banner.style.maxHeight = '0'; }
}

function refreshWeather() {
    const btn = document.getElementById('refreshWeatherBtn');
    if (btn) btn.classList.add('spin');
    WeatherModule.fetch(STATE.location.lat, STATE.location.lon).then(() => {
        if (btn) btn.classList.remove('spin');
    });
}

function clearLog() {
    STATE.ai.log = [];
    const c = document.getElementById('logScroll');
    if (c) c.innerHTML = '';
}

// ============================================================
//  UTILITY FUNCTIONS
// ============================================================
function clamp(val, min, max) { return Math.max(min, Math.min(max, val)); }
function lerp(a, b, t) { return a + (b - a) * t; }
function isEvenDay() { return new Date().getDate() % 2 === 0; }

function addLog(msg, level = 'info') {
    const time = new Date().toLocaleTimeString('en-IN', { hour12: false });
    STATE.ai.log.unshift({ time, msg, level });
    if (STATE.ai.log.length > 50) STATE.ai.log.pop();
}

// ============================================================
//  MAIN PHYSICS + AI TICK
// ============================================================
function physicsTick() {
    const { _tick } = STATE;
    const dtSeconds = CONFIG.PHYSICS_INTERVAL_MS / 1000;

    // ── Get system data from active module ──
    const data = SimModule.getSystemData();
    STATE.power.solar = parseFloat((data.solar ?? 0).toFixed(3));
    STATE.power.wind = parseFloat((data.wind ?? 0).toFixed(3));
    STATE.power.load = parseFloat((data.load ?? CONFIG.LOAD_NOMINAL).toFixed(3));

    // ── AI Decision Engine ──
    AIEngine.evaluate();

    // ── Update Battery SOC ──
    const battKW = STATE.power.battery * 1000;
    const newSOC = PhysicsModule.updateSOC(STATE.battery.soc, battKW, dtSeconds);
    STATE.battery.soc = parseFloat(clamp(newSOC, 0, 100).toFixed(2));

    // Battery electrical values
    const voltBase = 44 + (STATE.battery.soc / 100) * 10;
    STATE.battery.voltage = parseFloat(voltBase.toFixed(1));
    STATE.battery.current = parseFloat((Math.abs(battKW) / voltBase).toFixed(1));
    STATE.battery.temp = parseFloat((27 + Math.random() * 3).toFixed(1));

    // ETA
    if (STATE.power.battery > 0.001) {
        const remKWh = ((100 - STATE.battery.soc) / 100) * (CONFIG.BATT_CAPACITY_KWH / 1000);
        STATE.battery.etaHours = remKWh / (STATE.power.battery * 1000 / 1000);
    } else { STATE.battery.etaHours = null; }

    // ── Grid state simulation ──
    const even = isEvenDay();
    if (!STATE.gridA.fault) {
        STATE.gridA.outputMW = even ? 0 : CONFIG.GRID_A_MVA * 0.8 + (Math.random() - 0.5) * 0.2;
        STATE.gridA.mode = even ? 'Charging' : 'Supply';
        STATE.gridA.freq = parseFloat((50 + (Math.random() - 0.5) * 0.1).toFixed(2));
        STATE.gridA.stability = clamp(95 + (Math.random() - 0.5) * 4, 70, 100);
    }
    if (!STATE.gridB.fault) {
        STATE.gridB.outputMW = even ? CONFIG.GRID_B_MVA * 0.75 + (Math.random() - 0.5) * 0.2 : 0;
        STATE.gridB.mode = even ? 'Supply' : 'Charging';
        STATE.gridB.freq = parseFloat((50 + (Math.random() - 0.5) * 0.1).toFixed(2));
        STATE.gridB.stability = clamp(92 + (Math.random() - 0.5) * 4, 70, 100);
    }

    // ── EV charging logic ──
    const evEnabled = STATE.power.excess > 0 && STATE.battery.soc > CONFIG.BATT_SOC_EV && !STATE.isIslandMode;
    STATE.ev.active = evEnabled;
    if (evEnabled) {
        const rateKW = Math.min(CONFIG.EV_CHARGE_RATE_KW, STATE.power.excess * 1000);
        STATE.ev.chargeRateKW = rateKW;
        STATE.ev.sessionKWh += (rateKW * dtSeconds) / 3600;
        STATE.ev.battPct = clamp(STATE.ev.battPct + (rateKW / 60 * (dtSeconds / 3600)) * 100, 0, 100);
        const remKWh = (1 - STATE.ev.battPct / 100) * CONFIG.EV_CAPACITY_KWH;
        STATE.ev.etaMin = (remKWh / Math.max(rateKW, 0.1)) * 60;
        STATE.power.ev = rateKW / 1000;
    } else {
        STATE.ev.chargeRateKW = 0;
        STATE.ev.etaMin = null;
        STATE.power.ev = 0;
    }

    // ── Carbon tracking ──
    const dt3 = dtSeconds;
    const savedKg = PhysicsModule.co2Savings(STATE.power.solar, STATE.power.wind, dt3);
    const solarSavedKg = PhysicsModule.co2Savings(STATE.power.solar, 0, dt3);
    const windSavedKg = PhysicsModule.co2Savings(0, STATE.power.wind, dt3);
    STATE.carbon.totalKg += savedKg;
    STATE.carbon.solarKg += solarSavedKg;
    STATE.carbon.windKg += windSavedKg;

    // ── Alert from AI engine ──
    if (STATE._alertLevel && STATE._alertMsg) {
        UIRenderer.setAlert(STATE._alertLevel, STATE._alertMsg);
        STATE._alertLevel = null;
        STATE._alertMsg = null;
    }

    // ── Chart update ──
    ChartModule.update();

    // ── Timer ──
    STATE._nextPhysics = CONFIG.PHYSICS_INTERVAL_MS / 1000;
}

// ============================================================
//  UI TICK (every second)
// ============================================================
function uiTick() {
    UIRenderer.updateClock();
    UIRenderer.updateStatsStrip();
    UIRenderer.updateWeather();
    UIRenderer.updateFlow();
    UIRenderer.updateBattery();
    UIRenderer.updateAI();
    UIRenderer.updateEV();
    UIRenderer.updateCarbon();
    UIRenderer.updateFaultUI();

    // Countdown
    STATE._nextPhysics = Math.max(0, (STATE._nextPhysics ?? 3) - 1);
    const el = document.getElementById('footerNextUpdate');
    if (el) el.textContent = `Next update in ${STATE._nextPhysics}s`;

    STATE._tick++;
}

// ============================================================
//  APP INIT
// ============================================================
async function initApp() {
    console.log('🔋 Smart Microgrid EMS v2.1 starting...');

    // Init chart canvases
    ChartModule.init();

    // Init slider & control listeners
    initControls();

    // Initial alert
    UIRenderer.setAlert('info', 'System initializing — Fetching weather data and calibrating AI engine...');

    // Seed some chart history
    for (let i = CONFIG.CHART_HISTORY; i > 0; i--) {
        const t = new Date(Date.now() - i * CONFIG.PHYSICS_INTERVAL_MS);
        STATE.chart.labels.push(t.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false }));
        STATE.chart.solar.push(parseFloat((2 + Math.random() * 4).toFixed(2)));
        STATE.chart.wind.push(parseFloat((1 + Math.random() * 3).toFixed(2)));
        STATE.chart.load.push(parseFloat((8 + Math.random() * 3).toFixed(2)));
        STATE.chart.soc.push(parseFloat((65 + Math.random() * 15).toFixed(1)));
    }

    // Fetch initial weather (default: Asansol)
    await WeatherModule.fetch(CONFIG.DEFAULT_LAT, CONFIG.DEFAULT_LON);

    // Initial physics tick
    physicsTick();
    uiTick();

    // Start loops
    setInterval(physicsTick, CONFIG.PHYSICS_INTERVAL_MS);
    setInterval(uiTick, CONFIG.UI_INTERVAL_MS);
    setInterval(() => WeatherModule.fetch(STATE.location.lat, STATE.location.lon), CONFIG.WEATHER_INTERVAL_MS);

    // Initial log
    addLog('System initialized — AI engine online', 'success');
    addLog(`Default location: ${CONFIG.DEFAULT_CITY}`, 'info');
    addLog(`Duty cycle day ${new Date().getDate() % 2 === 0 ? 'EVEN' : 'ODD'} — ${isEvenDay() ? 'Grid A charging, Grid B supplying' : 'Grid B charging, Grid A supplying'}`, 'info');

    UIRenderer.showToast('Smart Microgrid EMS Online', 'success', 4000);

    console.log('✅ Smart Microgrid EMS ready.');
}

// ── Bootstrap ──
window.addEventListener('DOMContentLoaded', initApp);

// ── Resize chart on window resize ──
window.addEventListener('resize', () => { ChartModule.update(); });