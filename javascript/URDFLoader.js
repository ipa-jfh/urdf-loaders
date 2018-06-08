/* URDFLoader Class */
// Loads and reads a URDF file into a THREEjs Object3D format
window.URDFLoader =
class URDFLoader {

    // Cached mesh loaders
    get STLLoader() {
        this._stlloader = this._stlloader || new THREE.STLLoader(this.manager)
        return this._stlloader
    }

    get DAELoader() {
        this._daeloader = this._daeloader || new THREE.ColladaLoader(this.manager)
        return this._daeloader
    }

    get TextureLoader() {
        this._textureloader = this._textureloader || new THREE.TextureLoader(this.manager)
        return this._textureloader
    }

    constructor(manager) {

        this.manager = manager || THREE.DefaultLoadingManager

    }

    /* Utilities */
    // forEach and filter function wrappers because
    // HTMLCollection does not the by default
    forEach(coll, func)  { return [].forEach.call(coll, func) }
    filter(coll, func)   { return [].filter.call(coll, func) }

    // take a vector "x y z" and process it into
    // an array [x, y, z]
    _processTuple(val) {
        if (!val) return [0, 0, 0]
        return val.trim().split(/\s+/g).map(num => parseFloat(num))
    }

    // applies a rotation a threejs object in URDF order
    _applyRotation(obj, rpy) {
        obj.rotateOnAxis(new THREE.Vector3(0,0,1), rpy[2])
        obj.rotateOnAxis(new THREE.Vector3(0,1,0), rpy[1])
        obj.rotateOnAxis(new THREE.Vector3(1,0,0), rpy[0])
    }

    /* Public API */
    // pkg:     The equivelant of a ROS package:// directory
    // urdf:    The URDF path in the directory
    // cb:      Callback that is passed the model once loaded
    load(pkg, urdf, cb, loadMeshCb, fetchOptions) {

        // normalize the path slashes
        // let path = `${pkg}/${urdf}`.replace(/\\/g, '/').replace(/\/+/g, '/')
        // path = this.manager.resolveURL(path);
        let path = urdf

        fetch(path, fetchOptions)
            .then(res => res.text())
            .then(data => this.parse(pkg, data, cb, loadMeshCb))
    }

    parse(pkg, content, cb, loadMeshCb) {
        cb(this._processUrdf(pkg, content, loadMeshCb || this.defaultMeshLoader))
    }

    // Default mesh loading function
    defaultMeshLoader(path, ext, done) {

        if (/\.stl$/i.test(path))
            this.STLLoader.load(path, geom => {
                const mesh = new THREE.Mesh()
                mesh.geometry = geom
                done(mesh)
            })
        else if (/\.dae$/i.test(path))
            this.DAELoader.load(path, dae => done(dae.scene))
        else
            console.warn(`Could note load model at ${path}:\nNo loader available`)
    }

    /* Private Functions */
    // Process the URDF text format
    _processUrdf(pkg, data, loadMeshCb) {
        const parser = new DOMParser()
        const urdf = parser.parseFromString(data, 'text/xml')

        const robottag = this.filter(urdf.children, c => c.nodeName === 'robot').pop()
        return this._processRobot(pkg, robottag, loadMeshCb)
    }

    // Process the <robot> node
    _processRobot(pkg, robot, loadMeshCb) {
        const links = []
        const joints = []
        const obj = new THREE.Object3D()
        obj.name = robot.getAttribute('name')
        obj.urdf = { node: robot }

        // Process the <joint> and <link> nodes
        this.forEach(robot.children, n => {
            const type = n.nodeName.toLowerCase()
            if (type === 'link')        links.push(n)
            else if (type === 'joint')  joints.push(n)
        })

        // Create the <link> map
        const linkMap = {}
        this.forEach(links, l => {
            const name = l.getAttribute('name')
            linkMap[name] = this._processLink(pkg, l, loadMeshCb)
        })

        // Create the <joint> map
        const jointMap = {}
        this.forEach(joints, j => {
            const name = j.getAttribute('name')
            jointMap[name] = this._processJoint(j, linkMap)
        })

        for (let key in linkMap) linkMap[key].parent ? null : obj.add(linkMap[key])

        obj.urdf.joints = jointMap
        obj.urdf.links = linkMap

        return obj
    }

    // Process joint nodes and parent them
    _processJoint(joint, linkMap) {
        const jointType = joint.getAttribute('type')
        const obj = new THREE.Object3D()
        obj.name = joint.getAttribute('name')
        obj.urdf = {
            node: joint, type: jointType, angle: 0, axis: null,
            limits: { lower: 0, upper: 0 },
            ignoreLimits: false,
            setAngle: () => {}
        }

        let parent = null
        let child = null
        let xyz = [0, 0, 0]
        let rpy = [0, 0, 0]

        // Extract the attributes
        this.forEach(joint.children, n => {
            const type = n.nodeName.toLowerCase()
            if (type === 'origin') {
                xyz = this._processTuple(n.getAttribute('xyz'))
                rpy = this._processTuple(n.getAttribute('rpy'))
            } else if(type === 'child') {
                child = linkMap[n.getAttribute('link')]
            } else if(type === 'parent') {
                parent = linkMap[n.getAttribute('link')]
            } else if(type === 'limit') {
                obj.urdf.limits.lower = parseFloat(n.getAttribute('lower') || obj.urdf.limits.lower)
                obj.urdf.limits.upper = parseFloat(n.getAttribute('upper') || obj.urdf.limits.upper)
            }
        })

        // Join the links
        parent.add(obj)
        obj.add(child)
        this._applyRotation(obj, rpy)
        obj.position.set(xyz[0], xyz[1], xyz[2])

        // Set up the rotate function
        const origRot = new THREE.Quaternion().copy(obj.quaternion)
        const origPos = new THREE.Vector3().copy(obj.position)
        const axisnode = this.filter(joint.children, n => n.nodeName.toLowerCase() === 'axis')[0]

        if (axisnode) {
            const axisxyz = axisnode.getAttribute('xyz').split(/\s+/g).map(num => parseFloat(num))
            obj.urdf.axis = new THREE.Vector3(axisxyz[0], axisxyz[1], axisxyz[2])
            obj.urdf.axis.normalize()
        }

        switch (jointType) {
            case 'fixed': break;
            case 'continuous':
            console.log("!!!!!!!!!!!!!!!!!!!!!!!!!!!");
            
                obj.urdf.limits.lower = -Infinity
                obj.urdf.limits.upper = Infinity

                // fall through to revolute joint 'setAngle' function
            case 'revolute':
                obj.urdf.setAngle = function(angle = null) {
                    if (!this.axis) return
                    if (angle == null) return

                    if (!this.ignoreLimits) {
                        angle = Math.min(this.limits.upper, angle)
                        angle = Math.max(this.limits.lower, angle)
                    }

                    // FromAxisAngle seems to rotate the opposite of the
                    // expected angle for URDF, so negate it here
                    const delta = new THREE.Quaternion().setFromAxisAngle(this.axis, angle * -1)
                    obj.quaternion.multiplyQuaternions(origRot, delta)

                    this.angle = angle
                }
                break

            case 'prismatic':
                obj.urdf.setAngle = function(angle = null) {
                    if (!this.axis) return
                    if (angle == null) return

                    if (!this.ignoreLimits) {
                        angle = Math.min(this.limits.upper, angle)
                        angle = Math.max(this.limits.lower, angle)
                    }

                    obj.position.copy(origPos);
                    obj.position.addScaledVector(this.axis, angle)

                    this.angle = angle
                }
                break

            case 'floating':
            case 'planar':
                // TODO: Support these joint types
                console.warn(`'${ jointType }' joint not yet supported`)
        }

        // copy the 'setAngle' function over to 'set' so
        // it makes sense for other joint types (prismatic, planar)
        // TODO: Remove the 'setAngle' function
        // TODO: Figure out how to handle setting and getting angles of other types
        obj.urdf.set = obj.urdf.setAngle

        return obj
    }

    // Process the <link> nodes
    _processLink(pkg, link, loadMeshCb) {
        const visualNodes = this.filter(link.children, n => n.nodeName.toLowerCase() === 'visual')
        const obj = new THREE.Object3D()
        obj.name = link.getAttribute('name')
        obj.urdf = { node: link }

        this.forEach(visualNodes, vn => this._processVisualNode(pkg, vn, obj, loadMeshCb))

        return obj
    }

    // Process the visual nodes into meshes
    _processVisualNode(pkg, vn, linkObj, loadMeshCb) {
        let xyz = [0, 0, 0]
        let rpy = [0, 0, 0]
        let scale = [1, 1, 1]
        let mesh = null

        const material = new THREE.MeshLambertMaterial()
        this.forEach(vn.children, n => {
            const type = n.nodeName.toLowerCase()
            if (type === 'geometry') {
                const geoType = n.children[0].nodeName.toLowerCase()
                if (geoType === 'mesh') {
                    const filename = n.children[0].getAttribute('filename').replace(/^((package:\/\/)|(model:\/\/))/, '')
                    const path = pkg + '/' + filename
                    const ext = path.match(/.*\.([A-Z0-9]+)$/i).pop() || ''
                    let scale_exist = n.children[0].getAttribute('scale')
                    if (scale_exist) scale = this._processTuple(scale_exist)

                    loadMeshCb(path, ext, obj => {
                        if (obj) {
                            if (obj instanceof THREE.Mesh) {
                                obj.material = material
                            }

                            linkObj.add(obj)

                            obj.position.set(xyz[0], xyz[1], xyz[2])
                            obj.rotation.set(0,0,0)                            
                            obj.scale.set(scale[0], scale[1], scale[2])
                            this._applyRotation(obj, rpy)
                        }
                    })
                } else if (geoType === 'box') {
                    requestAnimationFrame(() => {
                        const mesh = new THREE.Mesh()
                        mesh.geometry = new THREE.BoxGeometry(1, 1, 1)
                        mesh.material = material

                        const size = this._processTuple(n.children[0].getAttribute('size'))

                        linkObj.add(mesh)
                        this._applyRotation(mesh, rpy)
                        mesh.position.set(xyz[0], xyz[1], xyz[2])
                        mesh.scale.set(size[0], size[1], size[2])
                    })
                } else if (geoType === 'sphere') {
                    requestAnimationFrame(() => {
                        const mesh = new THREE.Mesh()
                        mesh.geometry = new THREE.SphereGeometry(1, 20, 20)
                        mesh.material = material

                        const radius = parseFloat(n.children[0].getAttribute('radius')) || 0
                        mesh.position.set(xyz[0], xyz[1], xyz[2])
                        mesh.scale.set(radius, radius, radius)
                    })
                } else if (geoType === 'cylinder') {
                    requestAnimationFrame(() => {
                        const radius = parseFloat(n.children[0].getAttribute('radius')) || 0
                        const length = parseFloat(n.children[0].getAttribute('length')) || 0

                        const mesh = new THREE.Mesh()
                        mesh.geometry = new THREE.CylinderBufferGeometry(1, 1, 1, 25)
                        mesh.material = material
                        mesh.scale.set(radius, length, radius)

                        const obj = new THREE.Object3D()
                        obj.add(mesh)
                        mesh.rotation.set(Math.PI, 0, 0)

                        linkObj.add(obj)
                        this._applyRotation(obj, rpy)
                        obj.position.set(xyz[0], xyz[1], xyz[2])
                    })
                }
            } else if(type === 'origin') {
                xyz = this._processTuple(n.getAttribute('xyz'))
                console.log("xyz", n, xyz);
                
                rpy = this._processTuple(n.getAttribute('rpy'))
            } else if(type === 'material') {
                this.forEach(n.children, c => {

                    if (c.nodeName.toLowerCase() === 'color') {
                        let rgba = c.getAttribute('rgba')
                            .split(/\s/g)
                            .map(v => parseFloat(v))

                        material.color.r = rgba[0]
                        material.color.g = rgba[1]
                        material.color.b = rgba[2]
                        material.opacity = rgba[3]

                        if (material.opacity < 1) material.transparent = true

                    } else if (c.nodeName.toLowerCase() === 'texture') {
                        const filename = c.getAttribute('filename').replace(/^(package:\/\/)/, '')
                        const path = pkg + '/' + filename
                        material.map = this._textureloader.load(path)
                    }
                })
            }
        })
    }
}
