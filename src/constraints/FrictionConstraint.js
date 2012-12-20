/**
 * @class CANNON.FrictionConstraint
 * @brief Constrains the slipping in a contact along a tangent
 * @author schteppe
 * @param CANNON.RigidBody bi
 * @param CANNON.RigidBody bj
 * @extends CANNON.Constraint
 */
CANNON.FrictionConstraint = function(bi,bj){
    CANNON.Constraint.call(this);

    this.bi = bi;
    this.bj = bj;
    this.ri = new CANNON.Vec3();
    this.penetrationVec = new CANNON.Vec3();
    this.rj = new CANNON.Vec3();
    this.t = new CANNON.Vec3(); // tangent

    this.rixt = new CANNON.Vec3();
    this.rjxt = new CANNON.Vec3();
    this.wixri = new CANNON.Vec3();
    this.wixrj = new CANNON.Vec3();

    this.invIi = new CANNON.Mat3();
    this.invIj = new CANNON.Mat3();

    // should be +-F_friction = +-mu * F_normal = +-mu * m * g
    this.minForce = -10;
    this.maxForce =  10; 

    this.relVel = new CANNON.Vec3();
    this.relForce = new CANNON.Vec3();
};

CANNON.FrictionConstraint.prototype = new CANNON.Constraint();
CANNON.FrictionConstraint.prototype.constructor = CANNON.FrictionConstraint;

CANNON.FrictionConstraint.prototype.computeB = function(a,b,h){
    var bi = this.bi;
    var bj = this.bj;
    var ri = this.ri;
    var rj = this.rj;
    var rixt = this.rixt;
    var rjxt = this.rjxt;

    var vi = bi.velocity;
    var wi = bi.angularVelocity ? bi.angularVelocity : new CANNON.Vec3();
    var fi = bi.force;
    var taui = bi.tau ? bi.tau : new CANNON.Vec3();

    var vj = bj.velocity;
    var wj = bj.angularVelocity ? bj.angularVelocity : new CANNON.Vec3();
    var fj = bj.force;
    var tauj = bj.tau ? bj.tau : new CANNON.Vec3();

    var relVel = this.relVel;
    var relForce = this.relForce;
    var penetrationVec = this.penetrationVec;
    var invMassi = bi.invMass;
    var invMassj = bj.invMass;

    var invIi = this.invIi;
    var invIj = this.invIj;

    if(bi.invInertia) invIi.setTrace(bi.invInertia);
    else              invIi.identity();
    if(bj.invInertia) invIj.setTrace(bj.invInertia);
    else              invIj.identity();

    var n = this.ni;

    // Caluclate cross products
    ri.cross(t,rixt);
    rj.cross(t,rjxt);

    var Gq = 0; // we do only want to constrain motion
    var GW = vj.dot(t) - vi.dot(t) +wjxrj.dot(t) - wixri.dot(t); // eq. 40
    var GiMf = fj.dot(t)*invMassj - fi.dot(t)*invMassi + rjxt.dot(invIj.vmult(tauj)) - rixt.dot(invIi.vmult(taui));

    var B = - Gq * a - GW * b - h*GiMf;

    return B;
};

// Compute C = G * Minv * G + eps
CANNON.FrictionConstraint.prototype.computeC = function(eps){
    var bi = this.bi;
    var bj = this.bj;
    var rixt = this.rixt;
    var rjxt = this.rjxt;
    var invMassi = bi.invMass;
    var invMassj = bj.invMass;

    var C = invMassi + invMassj + eps;

    var invIi = this.invIi;
    var invIj = this.invIj;

    if(bi.invInertia) invIi.setTrace(bi.invInertia);
    else              invIi.identity();
    if(bj.invInertia) invIj.setTrace(bj.invInertia);
    else              invIj.identity();

    // Compute rxt * I * rxt for each body
    C += invIi.vmult(rixt).dot(rixt);
    C += invIj.vmult(rjxt).dot(rjxt);

    return C;
};

CANNON.FrictionConstraint.prototype.computeGWlambda = function(){

    // Correct at all ???
    
    var bi = this.bi;
    var bj = this.bj;

    var GWlambda = 0.0;
    var ulambda = bj.vlambda.vsub(bi.vlambda);
    GWlambda += ulambda.dot(this.t);

    // Angular
    if(bi.wlambda)
        GWlambda -= bi.wlambda.dot(this.rixt);
    if(bj.wlambda)
        GWlambda += bj.wlambda.dot(this.rjxt);

    return GWlambda;
};

CANNON.FrictionConstraint.prototype.addToWlambda = function(deltalambda){
    var bi = this.bi;
    var bj = this.bj;
    var rixt = this.rixt;
    var rjxt = this.rjxt;
    var invMassi = bi.invMass;
    var invMassj = bj.invMass;
    var t = this.t;

    // Add to linear velocity
    bi.vlambda.vsub(t.mult(invMassi * deltalambda),bi.vlambda);
    bj.vlambda.vadd(t.mult(invMassj * deltalambda),bj.vlambda);

    // Add to angular velocity
    if(bi.wlambda){
        var I = this.invIi;
        bi.wlambda.vsub(I.vmult(rixt).mult(deltalambda),bi.wlambda);
    }
    if(bj.wlambda){
        var I = this.invIj;
        bj.wlambda.vadd(I.vmult(rjxt).mult(deltalambda),bj.wlambda);
    }
};