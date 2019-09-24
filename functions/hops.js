'use strict'
const admin = require('firebase-admin')
require('events').EventEmitter.defaultMaxListeners = 0

const dc = require('nmsbhs-utils')
const readline = require('readline')

let savedHops = {}
let savedPOI = {}

exports.genRoute = async function (data) {
    let now = new Date().getTime()
    if (data.galaxy === "" || data.platform === "")
        return {
            err: "no Galaxy/Platform specified"
        }

    let p = []
    p.push(getHops(data.galaxy, data.platform))
    p.push(getPOI(data.galaxy, data.platform))

    if (data.preload) {
        return Promise.all(p).then(res => {
            console.log("preload", new Date().getTime() - now)
            return {
                loaded: true,
                preload: new Date().getTime() - now
            }
        })
    }

    if (data.user !== "" && data.usebases)
        p.push(addBases(data.user, data.start, data.galaxy, data.platform))

    if (!data.proximity) {
        if (data.end !== "" && data.end !== "0000:0000:0000:0000")
            p.push(getAddrEntry(data.end, data.galaxy, data.platform))
        else
            return {
                err: "No destination specified."
            }
    }

    return Promise.all(p).then(res => {
        let start = {
            addr: data.start === "" ? "0000:0000:0000:0000" : data.start
        }
        start.coords = dc.coordinates(start.addr)

        let end = {
            addr: data.end === "" ? "0000:0000:0000:0000" : data.end
        }
        end.coords = dc.coordinates(end.addr)

        let hops = []
        let poi = []
        let dest = []

        for (let r of res) {
            if (r) {
                switch (r.what) {
                    case "hops":
                        hops = hops.concat(r.list)
                        break
                    case "poi":
                        poi = r.list
                        break
                    case "addr":
                        end.system = r.entry.sys
                        end.region = r.entry.reg
                        break
                    case "bases":
                        hops = hops.concat(r.list)
                        break
                }
            }
        }

        if (data.proximity && poi.length > 0)
            dest = poi
        else
            dest.push(end)

        console.log("hops", data.galaxy, data.platform, hops.length)
        console.log("poi", data.galaxy, data.platform, poi.length)

        let calc = dc.dijkstraCalculator(hops, data.range, "time")

        let stime = new Date().getTime() - now
        console.log("setup", stime)
        now = new Date().getTime()

        let routes = calc.findRoutes(start, dest)
        let ctime = new Date().getTime() - now
        console.log("calc", ctime)

        routes = calcJumps(routes, data)
        let ptime = new Date().getTime() - now
        console.log("post", ptime)

        return {
            route: routes,
            calc: ctime,
            post: ptime,
            setup: stime
        }
    })
}

function getHops(gal, plat) {
    if (typeof savedHops[gal] === "undefined")
        savedHops[gal] = {}

    if (typeof savedHops[gal][plat] !== "undefined")
        return new Promise((resolve, reject) => {
            resolve({
                what: "hops",
                list: savedHops[gal][plat]
            })
        })

    savedHops[gal][plat] = []

    const bucket = admin.storage().bucket("nms-bhs.appspot.com")
    let fname = 'darc/' + gal + "-" + plat + ".json"

    let f = bucket.file(fname)
    return f.exists().then(data => {
            let p = []
            if (data[0]) {
                let s = f.createReadStream()
                let rd = readline.createInterface({
                    input: s
                })

                let out = []
                rd.on("line", line => {
                    if (line) {
                        let r = JSON.parse(line)
                        let h = {
                            blackhole: {
                                coords: dc.coordinates(r[0]),
                                addr: r[0],
                                region: r[1],
                                system: r[2],
                            },
                            exit: {
                                coords: dc.coordinates(r[3]),
                                addr: r[3],
                                region: r[4],
                                system: r[5],
                            }
                        }

                        out.push(h)
                    }
                })

                p.push(new Promise((resolve, reject) => {
                    savedHops[gal][plat] = out
                    rd.on("close", () => {
                        resolve()
                    })
                }))
            }

            return Promise.all(p).then(res => {
                return {
                    what: "hops",
                    list: savedHops[gal][plat]
                }
            })
        })
        .catch(err => {
            console.log(JSON.stringify(err))
        })
}

function getAddrEntry(addr, gal, plat) {
    let ref = admin.firestore().collection("stars5/" + gal + "/" + plat)
    ref = ref.where("addr", "==", addr)
    return ref.get().then(async snapshot => {
        if (!snapshot.empty)
            return {
                what: "addr",
                entry: snapshot.docs[0].data()
            }
        else return {
            what: "not found",
        }
    })
}

function calcJumps(routes, data) {
    let out = []

    for (const orig of routes) {
        const r = JSON.parse(JSON.stringify(orig))
        let nr = []
        found = {}
        const last = r.route[r.route.length - 1]
        let jumps = 0
        r.bh = 0

        for (let i = 0; i < r.route.length; ++i) {
            const l = r.route[i]

            if (data.nearPath && !data.proximity && i > 0) {
                const list = checkPOI(l, data)
                for (let l of list)
                    nr.push(l)
            }

            const n = i < r.route.length - 1 ? r.route[i + 1] : null
            const ly = n ? Math.ceil(calcDistXYZ(n.coords, l.coords) * 400) : 0
            const j = Math.max(Math.ceil(ly / data.range), 1)

            l.jumps = 0
            l.dist = 0

            if (last.addr === l.addr && ly === 0)
                l.what = "arrived"
            else if (l.system === "Teleport") {
                l.what = "teleport"
                l.jumps = 1
                jumps = 1
            } else if (n && (n.system === "Teleport" || l.addr === n.addr))
                l.what = "loc"
            else if (l.coords.s === 0x79) {
                l.what = "bh"
                l.jumps = 1
                jumps++
                r.bh++
            } else {
                l.what = "warp"
                l.jumps = j
                l.dist = ly
                jumps += j
            }

            nr.push(l)
        }

        r.route = nr
        r.jumps = jumps
        out.push(r)
    }

    if (routes.length > 1) {
        out = out.filter(a => a.jumps > 1 && a.jumps <= data.maxJumps)
        out = out.sort((a, b) => a.jumps - b.jumps)
    }

    return out
}

var found = {}

function checkPOI(l, data) {
    let range = data.range / 400 * 2
    range = range * range
    let out = []

    for (let poi of savedPOI[data.galaxy][data.platform]) {
        const d = calcDistSqXYZ(l.coords, poi.coords)
        if (typeof found[poi.addr] === "undefined" && d > 0 && d < range) {
            found[poi.addr] = true
            if (poi.owner !== data.user) {
                poi.dist = parseInt(Math.sqrt(d) * 400)
                poi.jumps = Math.ceil(poi.dist / data.range)
                poi.what = "poi"
                out.push(poi)
            }
        }
    }

    return out
}

function calcDistXYZ(xyz1, xyz2) {
    const x = xyz1.x - xyz2.x
    const y = xyz1.y - xyz2.y
    const z = xyz1.z - xyz2.z
    return Math.sqrt(x * x + y * y + z * z)
}

function calcDistSqXYZ(xyz1, xyz2) {
    const x = xyz1.x - xyz2.x
    const y = xyz1.y - xyz2.y
    const z = xyz1.z - xyz2.z
    return x * x + y * y + z * z
}

function addBases(user, start, gal, plat) {
    let ref = admin.firestore().collection("users")
    ref = ref.where("_name", "==", user)
    let startcoords = dc.coordinates(start === "" ? "0000:0000:0000:0000" : start)

    return ref.get().then(snapshot => {
        if (snapshot.size > 0) {
            let ref = snapshot.docs[0].ref.collection("stars5/" + gal + "/" + plat)
            return ref.get().then(snapshot => {
                let list = []
                for (let doc of snapshot.docs) {
                    let e = doc.data()
                    let h = {
                        blackhole: {
                            coords: startcoords,
                            addr: start,
                            region: e.basename,
                            system: "Teleport",
                        },
                        exit: {
                            coords: dc.coordinates(e.addr),
                            addr: e.addr,
                            region: e.reg,
                            system: e.sys,
                        }
                    }

                    list.push(h)
                }

                return {
                    what: "bases",
                    list: list
                }
            })
        } else
            return
    })
}

function getPOI(gal, plat) {
    if (typeof savedPOI[gal] === "undefined")
        savedPOI[gal] = {}

    if (typeof savedPOI[gal][plat] !== "undefined")
        return new Promise((resolve, reject) => {
            resolve({
                what: "poi",
                list: savedPOI[gal][plat]
            })
        })

    savedPOI[gal][plat] = []

    const bucket = admin.storage().bucket("nms-bhs.appspot.com")
    let fname = 'darc/poi/' + gal + "-" + plat + ".json"

    let f = bucket.file(fname)
    return f.exists().then(data => {
            let p = []
            if (data[0]) {
                let s = f.createReadStream()
                let rd = readline.createInterface({
                    input: s
                })

                let out = []
                rd.on("line", line => {
                    if (line) {
                        let r = JSON.parse(line)
                        let h = {
                            coords: dc.coordinates(r[0]),
                            addr: r[0],
                            region: r[1],
                            system: r[2],
                            name: r[3],
                            owner: r[4],
                            type: r[5],
                        }

                        out.push(h)
                    }
                })

                p.push(new Promise((resolve, reject) => {
                    savedPOI[gal][plat] = out

                    rd.on("close", () => {
                        resolve()
                    })
                }))
            }

            return Promise.all(p).then(res => {
                return {
                    what: "poi",
                    list: savedPOI[gal][plat]
                }
            })
        })
        .catch(err => {
            console.log(JSON.stringify(err))
        })
}

exports.genPOI = function () {
    const bucket = admin.storage().bucket("nms-bhs.appspot.com")
    let p = []

    let ref = admin.firestore().collection("poi")
    p.push(getPOIlist(ref, "name", "owner", "poi"))

    ref = admin.firestore().collection("org")
    p.push(getPOIlist(ref, "name", "owner", "org"))

    ref = admin.firestore().collection("users")
    p.push(ref.listDocuments().then(async docrefs => {
        let p = []

        for (let ref of docrefs) {
            ref = ref.collection("stars5")
            for (let gref of await ref.listDocuments())
                for (let pref of await gref.listCollections()) {
                    pref = pref.where("sharepoi", "==", true)
                    p.push(getPOIlist(pref, "basename", "_name", "base"))
                }
        }

        return Promise.all(p).then(res => {
            let m = {}
            for (let l of res) {
                for (let g of Object.keys(l)) {
                    for (let p of Object.keys(l[g])) {
                        if (typeof m[g] === "undefined")
                            m[g] = {}
                        if (typeof m[g][p] === "undefined")
                            m[g][p] = []

                        m[g][p] = m[g][p].concat(l[g][p])
                    }
                }
            }

            return m
        })
    }))

    return Promise.all(p).then(res => {
        let m = {}
        for (let l of res) {
            for (let g of Object.keys(l)) {
                for (let p of Object.keys(l[g])) {
                    if (typeof m[g] === "undefined")
                        m[g] = {}
                    if (typeof m[g][p] === "undefined")
                        m[g][p] = []

                    m[g][p] = m[g][p].concat(l[g][p])
                }
            }
        }

        for (let g of Object.keys(m)) {
            for (let p of Object.keys(m[g])) {
                m[g][p] = m[g][p].sort((a, b) => a.addr > b.addr ? 1 : -1)
                m[g][p] = m[g][p].filter((v, i, a) => ++i >= a.length || v.addr !== a[i].addr || v.reg !== a[i].reg || v.sys !== a[i].sys || v.name !== a[i].name || v.owner !== a[i].owner)
                m[g][p] = m[g][p].map(e => JSON.stringify([e.addr, e.reg, e.sys, e.name, e.owner, e.type]) + "\n")
            }
        }

        let pr = []

        for (let g of Object.keys(m)) {
            for (let p of Object.keys(m[g])) {
                pr.push(new Promise((resolve, reject) => {
                    let fname = 'darc/poi/' + g + "-" + p + ".json"
                    let f = bucket.file(fname)
                    let s = f.createWriteStream({
                        gzip: true,
                    })

                    s.on('finish', () => {
                        resolve(true)
                    })

                    for (let e of m[g][p])
                        s.write(e)

                    s.end()
                }))
            }
        }

        return Promise.all(pr).then(res => {
            return {
                ok: true
            }
        }).catch(err => {
            console.log("error", JSON.stringify(err))
            return {
                err: JSON.stringify(err)
            }
        })
    })
}

function getPOIlist(ref, namefld, ownerfld, type) {
    return ref.get().then(async snapshot => {
        let l = []

        for (let doc of snapshot.docs) {
            let e = doc.data()

            if (doc.ref.path.includes("users/") ||
                (doc.ref.path.includes("poi/") || doc.ref.path.includes("org/")) && (typeof e.hide === "undefined" || e.hide === false)) {

                if (typeof l[e.galaxy] === "undefined")
                    l[e.galaxy] = {}

                let plat = []
                if (ref.id === "org") {
                    if (typeof e["PC-XBox"] !== "undefined" && e["PC-XBox"] === true)
                        plat.push("PC-XBox")
                    if (typeof e["PS4"] !== "undefined" && e["PS4"] === true)
                        plat.push("PS4")
                } else
                    plat.push(e.platform)

                for (let p of plat) {
                    if (typeof l[e.galaxy][p] === "undefined")
                        l[e.galaxy][p] = []

                    if (typeof e.sys === "undefined" || typeof e.reg === "undefined") {
                        let ref = admin.firestore().doc("stars5/" + e.galaxy + "/" + p + "/" + e.addr)
                        let edoc = await ref.get()
                        if (edoc.exists) {
                            let s = edoc.data()
                            e.sys = s.sys
                            e.reg = s.reg
                            doc.ref.set(e)
                        }
                    }

                    l[e.galaxy][p].push({
                        addr: e.addr,
                        reg: e.reg,
                        sys: e.sys,
                        name: e[namefld],
                        owner: e[ownerfld],
                        type: type
                    })
                }
            }
        }

        return l
    })
}