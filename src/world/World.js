/*global CANNON:true */

/**
 * @class CANNON.World
 * @brief The physics world
 */
CANNON.World = function(){

  /// The wall-clock time since simulation start
  this.time = 0.0;

  /// Number of timesteps taken since start
  this.stepnumber = 0;

  /// Spring constant
  this.spook_k = 3000.0;

  /// Stabilization parameter (number of timesteps until stabilization)
  this.spook_d = 3.0;

  /// Default and last timestep sizes
  this.default_dt = 1/60;
  this.last_dt = this.default_dt;

  this.nextId = 0;
  this.gravity = new CANNON.Vec3();
  this.broadphase = null;
  this.bodies = [];

  var th = this;

  /// Contact solver parameters, @see https://www8.cs.umu.se/kurser/5DV058/VT09/lectures/spooknotes.pdf
  this.spook_a = function(h){ return 4.0 / (h * (1 + 4 * th.spook_d)); };
  this.spook_b = (4.0 * this.spook_d) / (1 + 4 * this.spook_d);
  this.spook_eps = function(h){ return 4.0 / (h * h * th.spook_k * (1 + 4 * th.spook_d)); };

  /// The contact solver
  this.solver = new CANNON.Solver(this.spook_a(1.0/60.0),
				  this.spook_b,
				  this.spook_eps(1.0/60.0),
				  this.spook_k,
				  this.spook_d,
				  5,
				  1.0/60.0);

  // Materials
  this.materials = []; // References to all added materials
  this.contactmaterials = []; // All added contact materials
  this.mats2cmat = []; // Hash: (mat1_id, mat2_id) => contactmat_id

  this.temp = {
    gvec:new CANNON.Vec3(),
    vi:new CANNON.Vec3(),
    vj:new CANNON.Vec3(),
    wi:new CANNON.Vec3(),
    wj:new CANNON.Vec3(),
    t1:new CANNON.Vec3(),
    t2:new CANNON.Vec3(),
    rixn:new CANNON.Vec3(),
    rjxn:new CANNON.Vec3(),
    step_q:new CANNON.Quaternion(),
    step_w:new CANNON.Quaternion(),
    step_wq:new CANNON.Quaternion()
  };
};

/**
 * @fn getContactMaterial
 * @memberof CANNON.World
 * @brief Get the contact material between materials m1 and m2
 * @param CANNON.Material m1
 * @param CANNON.Material m2
 * @return CANNON.Contactmaterial The contact material if it was found.
 */
CANNON.World.prototype.getContactMaterial = function(m1,m2){
  if((m1 instanceof CANNON.Material) && 
     (m2 instanceof CANNON.Material)){

    var i = m1.id;
    var j = m2.id;

    if(i<j){
      var temp = i;
      i = j;
      j = temp;
    }
    return this.contactmaterials[this.mats2cmat[i+j*this.materials.length]];
  }
};

/**
 * @private
 * @fn _addImpulse
 * @memberof CANNON.World
 * @brief Add an impulse to the colliding bodies i and j
 * @param int i Body number 1
 * @param int i Body number 2
 * @param CANNON.Vec3 ri Vector from body 1's center of mass to the contact point on its surface
 * @param CANNON.Vec3 ri Vector from body 1's center of mass to the contact point on its surface
 * @param CANNON.Vec3 ui The relative velocity eg. vj+wj*rj - (vi+wj*rj)
 * @param CANNON.Vec3 ni The contact normal pointing out from body i.
 * @param float e The coefficient of restitution
 * @param float mu The contact friction
 * @todo Use it in the code!
 */
CANNON.World.prototype._addImpulse = function(i,j,ri,rj,ui,ni,e,mu){

  var ri_star = ri.crossmat();
  var rj_star = rj.crossmat();
  
  // Inverse inertia matrices
  var ii = this.inertiax[i]>0 ? 1.0/this.inertiax[i] : 0.0;
  var Iinv_i = new CANNON.Mat3([ii,0,0,
				0,ii,0,
				0,0,ii]);
  ii = this.inertiax[j]>0 ? 1.0/this.inertiax[j] : 0.0;
  var Iinv_j = new CANNON.Mat3([ii,0,0,
				0,ii,0,
				0,0,ii]);

  // Collision matrix:
  // K = 1/mi + 1/mj - ri_star*I_inv_i*ri_star - rj_star*I_inv_j*rj_star;
  var im = this.invm[i] + this.invm[j];
  var K = new CANNON.Mat3([im,0,0,
			   0,im,0,
			   0,0,im]);
  var rIr_i = ri_star.mmult(Iinv_i.mmult(ri_star));
  var rIr_j = rj_star.mmult(Iinv_j.mmult(rj_star));

  /*
  // @todo add back when this works
  for(var el = 0; el<9; el++)
    K.elements[el] -= (rIr_i.elements[el] + rIr_j.elements[el]);
  */
	
  // First assume stick friction
  // Final velocity if stick:
  var v_f = ni.mult(-e * ui.dot(ni));

  var J =  K.solve(v_f.vsub(ui));

  // Check if slide mode (J_t > J_n) - outside friction cone
  var mu = 0.0; // quick fix
  if(mu>0){
    var J_n = ni.mult(J.dot(ni));
    var J_t = J.vsub(J_n);
    if(J_t.norm() > J_n.mult(mu).norm()){

      // Calculate impulse j = -(1+e)u_n / nK(n-mu*t)
      var v_tang = ui.vsub(ni.mult(ui.dot(ni)));
      var tangent = v_tang.mult(1.0/(v_tang.norm() + 0.0001));
      var impulse = -(1+e)*(ui.dot(ni))/(ni.dot(K.vmult((ni.vsub(tangent.mult(mu))))));
      J = ni.mult(impulse).vsub(tangent.mult(mu * impulse));
    }
  }

  // Add to velocities
  var imi = this.invm[i];
  var imj = this.invm[j];

  // du = uprim - u
  //   => uprim = du + u
  // vi = vi + J/mi
  // vj = vj - J/mj

  // Convert back to non-relative velocities:
  // u_rel = vj - vi
  // vi = vj - u_rel
  // vj = vi + u_rel

  this.vx[i] +=  J.x * imi - (this.vx[j] - ui.x);
  this.vy[i] +=  J.y * imi - (this.vy[j] - ui.y);
  this.vz[i] +=  J.z * imi - (this.vz[j] - ui.z);
  this.vx[j] -=  J.x * imj + (this.vx[i] + ui.x);
  this.vy[j] -=  J.y * imj + (this.vy[i] + ui.y);
  this.vz[j] -=  J.z * imj + (this.vz[i] + ui.z);

  var cr = ri.cross(J);
  var wadd = cr.mult(1.0/this.inertiax[i]);

  /*
  // Add rotational impulses
  this.wx[i] += wadd.x;
  this.wy[i] += wadd.y;
  this.wz[i] += wadd.z;
  cr = rj.cross(J);
  wadd = cr.mult(1.0/this.inertiax[j]); // @todo fix to suit asymmetric inertia
  this.wx[j] -= wadd.x;
  this.wy[j] -= wadd.y;
  this.wz[j] -= wadd.z;
  */
};

/**
 * @fn numObjects
 * @memberof CANNON.World
 * @brief Get number of objects in the world.
 * @return int
 */
CANNON.World.prototype.numObjects = function(){
  return this.bodies.length;
};

/**
 * @fn clearCollisionState
 * @memberof CANNON.World
 * @brief Clear the contact state for a body.
 * @param CANNON.RigidBody body
 */
CANNON.World.prototype.clearCollisionState = function(body){
  var n = this.numObjects();
  var i = body.id;
  for(var idx=0; idx<n; idx++){
    var j = idx;
    if(i>j) this.collision_matrix[j+i*n] = 0;
    else    this.collision_matrix[i+j*n] = 0;
  }
};

/**
 * @fn add
 * @memberof CANNON.World
 * @brief Add a rigid body to the simulation.
 * @param CANNON.RigidBody body
 * @todo If the simulation has not yet started, why recrete and copy arrays for each body? Accumulate in dynamic arrays in this case.
 * @todo Adding an array of bodies should be possible. This would save some loops too
 */
CANNON.World.prototype.add = function(body){
  if(body instanceof CANNON.RigidBody){
    var n = this.numObjects();
    this.bodies.push(body);
    body.id = this.id();
    body.world = this;
    body.position.copy(body.initPosition);
    body.velocity.copy(body.initVelocity);
    body.angularVelocity.copy(body.initAngularVelocity);
    body.quaternion.copy(body.initQuaternion);
    
    // Create collision matrix
    this.collision_matrix = new Int16Array((n+1)*(n+1));
  }
};

CANNON.World.prototype.id = function(){
  return this.nextId++;
};

/**
 * @fn remove
 * @memberof CANNON.World
 * @brief Remove a rigid body from the simulation.
 * @param CANNON.RigidBody body
 */
CANNON.World.prototype.remove = function(body){
  if(body instanceof CANNON.RigidBody){
    body.world = null;
    var n = this.numObjects();
    var bodies = this.bodies;
    for(var i in bodies)
      if(bodies[i].id == body.id)
	bodies.splice(i,1);

    // Reset collision matrix
    this.collision_matrix = new Int16Array((n-1)*(n-1));
  }
};

/**
 * @fn addMaterial
 * @memberof CANNON.World
 * @brief Adds a material to the World. A material can only be added once, it's added more times then nothing will happen.
 * @param CANNON.Material m
 */
CANNON.World.prototype.addMaterial = function(m){
  if(m.id==-1){
    this.materials.push(m);
    m.id = this.materials.length-1;

    // Enlarge matrix
    var newcm = new Int16Array((this.materials.length)
			       * (this.materials.length));
    for(var i=0; i<newcm.length; i++)
      newcm[i] = -1;

    // Copy over old values
    for(var i=0; i<this.materials.length-1; i++)
      for(var j=0; j<this.materials.length-1; j++)
	newcm[i+this.materials.length*j] = this.mats2cmat[i+(this.materials.length-1)*j];
    this.mats2cmat = newcm;
  
  }
};

/**
 * @fn addContactMaterial
 * @memberof CANNON.World
 * @brief Adds a contact material to the World
 * @param CANNON.ContactMaterial cmat
 */
CANNON.World.prototype.addContactMaterial = function(cmat) {

  // Add materials if they aren't already added
  this.addMaterial(cmat.materials[0]);
  this.addMaterial(cmat.materials[1]);

  // Save (material1,material2) -> (contact material) reference for easy access later
  // Make sure i>j, ie upper right matrix
  if(cmat.materials[0].id > cmat.materials[1].id){
    i = cmat.materials[0].id;
    j = cmat.materials[1].id;
  } else {
    j = cmat.materials[0].id;
    i = cmat.materials[1].id;
  }
    
  // Add contact material
  this.contactmaterials.push(cmat);
  cmat.id = this.contactmaterials.length-1;

  // Add current contact material to the material table
  this.mats2cmat[i+this.materials.length*j] = cmat.id; // index of the contact material
};

/**
 * @fn step
 * @memberof CANNON.World
 * @brief Step the simulation
 * @param float dt
 */
CANNON.World.prototype.step = function(dt){
  var world = this,
  that = this,
  N = this.numObjects(),
  bodies = this.bodies;
  
  if(dt==undefined){
    if(this.last_dt)
      dt = this.last_dt;
    else
      dt = this.default_dt;
  }

  // 1. Collision detection
  var pairs = this.broadphase.collisionPairs(this);
  var p1 = pairs[0];
  var p2 = pairs[1];

  // Get references to things that are accessed often. Will save some lookup time.
  var SPHERE = CANNON.Shape.types.SPHERE;
  var PLANE = CANNON.Shape.types.PLANE;
  var BOX = CANNON.Shape.types.BOX;
  var COMPOUND = CANNON.Shape.types.COMPOUND;

  /**
   * Keep track of contacts for current and previous timesteps
   * @param int i Body index
   * @param int j Body index
   * @param int which 0 means current, -1 one timestep behind, -2 two behind etc
   * @param int newval New contact status
   */
  function cmatrix(i,j,which,newval){
    // i == column
    // j == row
    if((which==0 && i<j) || // Current uses upper part of the matrix
       (which==-1 && i>j)){ // Previous uses lower part of the matrix
      var temp = j;
      j = i;
      i = temp;
    }
    if(newval===undefined)
      return that.collision_matrix[i+j*that.numObjects()];
    else
      that.collision_matrix[i+j*that.numObjects()] = parseInt(newval);
  }

  // Begin with transferring old contact data to the right place
  for(var i in bodies)
    for(var j=0; j<i; j++){
      cmatrix(i,j,-1, cmatrix(i,j,0));
      cmatrix(i,j,0,0);
    }

  // Add gravity to all objects
  for(var i in bodies){
    var f = bodies[i].force, m = bodies[i].mass;
    f.x += world.gravity.x * m;
    f.y += world.gravity.y * m;
    f.z += world.gravity.z * m;
  }

  // Reset contact solver
  this.solver.reset(N);

  /**
   * Near phase calculation, get the contact point, normal, etc.
   * @param array result The result one will get back with all the contact point information
   * @param Shape si Colliding shape
   * @param Shape sj
   * @param Vec3 xi Position of the center of mass
   * @param Vec3 xj
   * @param Quaternion qi Rotation around the center of mass
   * @param Quaternion qj
   * @todo All collision cases
   * @todo Replace the current nearphase with this function.
   */
  function nearPhase(result,si,sj,xi,xj,qi,qj){
    var swapped = false;
    if(si.type>sj.type){
      var temp;
      temp=sj;   sj=si;   si=temp;
      temp=xj;   xj=xi;   xi=temp;
      temp=qj;   qj=qi;   qi=temp;
      swapped = true;
    }

    /**
     * Make a contact object.
     * @return object
     * @todo Perhaps we should make a Contact class out of this instead...
     */
    function makeResult(){
      return {
	  ri:new CANNON.Vec3(), // Vector from body i center to contact point
	  rj:new CANNON.Vec3(), // Vector from body j center to contact point
	  ni:new CANNON.Vec3()  // Contact normal protruding body i
	};
    }

    /**
     * Swaps the body references in the contact
     * @param object r
     */
    function swapResult(r){
      var temp = CANNON.Vec3();
      temp = r.ri; r.ri = r.rj; r.rj = temp;
      r.ni.negate(r.ni);
    }

    /**
     * Go recursive for compound shapes
     * @param Shape si
     * @param CompoundShape sj
     */
    function recurseCompound(result,si,sj,xi,xj,qi,qj){
      for(var i=0; i<sj.childShapes.length; i++){
	var r = [];
	nearPhase(r,
		  si,
		  sj.childShapes[i],
		  xi,
		  xj.vadd(qj.vmult(sj.childOffsets[i])), // Transform the shape to its local frame
		  qi,
		  qj.mult(sj.childOrientations[i]));
	// Transform back
	for(var j=0; j<r.length; j++){
	  r[j].rj.vadd(qj.vmult(sj.childOffsets[i]),r[j].rj);
	  result.push(r[j]);
	}
      }
    }

    if(si.type==CANNON.Shape.types.SPHERE){
      if(sj.type==CANNON.Shape.types.SPHERE){ // sphere-sphere

	// We will have one contact in this case
	var r = makeResult();

	// Contact normal
	xj.vsub(xi,r.ni);
	r.ni.normalize();

	// Contact point locations
	r.ni.copy(r.ri);
	r.ni.copy(r.rj);
	r.ri.mult(si.radius,r.ri);
	r.rj.mult(-sj.radius,r.rj);
	result.push(r);

      } else if(sj.type==CANNON.Shape.types.PLANE){ // sphere-plane

	// We will have one contact in this case
	var r = makeResult();

	// Contact normal
	sj.normal.copy(r.ni);
	qj.vmult(r.ni,r.ni);
	r.ni.negate(r.ni); // body i is the sphere, flip normal
	r.ni.normalize();

	// Vector from sphere center to contact point
	r.ni.mult(si.radius,r.ri);

	// Project down sphere on plane
	var point_on_plane_to_sphere = xi.vsub(xj);
	var plane_to_sphere_ortho = r.ni.mult(r.ni.dot(point_on_plane_to_sphere));
	r.rj = point_on_plane_to_sphere.vsub(plane_to_sphere_ortho); // The sphere position projected to plane
	if(plane_to_sphere_ortho.norm() <= si.radius)
	  result.push(r);
	
      } else if(sj.type==CANNON.Shape.types.BOX){ // sphere-box

	// we refer to the box as body j
	var box_to_sphere =  xi.vsub(xj);
	var sides = sj.getSideNormals(true,qj);
	var R =     si.radius;
	var penetrating_sides = [];

	// Check side (plane) intersections
	var found = false;
	for(var idx=0; idx<sides.length && !found; idx++){ // Max 3 penetrating sides
	  var ns = sides[idx].copy();
	  var h = ns.norm();
	  ns.normalize();
	  var dot = box_to_sphere.dot(ns);
	  if(dot<h+R && dot>0){
	    // Intersects plane. Now check the other two dimensions
	    var ns1 = sides[(idx+1)%3].copy();
	    var ns2 = sides[(idx+2)%3].copy();
	    var h1 = ns1.norm();
	    var h2 = ns2.norm();
	    ns1.normalize();
	    ns2.normalize();
	    var dot1 = box_to_sphere.dot(ns1);
	    var dot2 = box_to_sphere.dot(ns2);
	    if(dot1<h1 && dot1>-h1 && dot2<h2 && dot2>-h2){
	      found = true;
	      var r = makeResult();
	      ns.mult(-R,r.ri); // Sphere r
	      ns.copy(r.ni);
	      r.ni.negate(r.ni); // Normal should be out of sphere
	      ns.mult(h).vadd(ns1.mult(dot1)).vadd(ns2.mult(dot2),r.rj); // box
	      result.push(r);
	    }
	  }
	}

	// Check corners
	var rj = new CANNON.Vec3();
	for(var j=0; j<2 && !found; j++){
	  for(var k=0; k<2 && !found; k++){
	    for(var l=0; l<2 && !found; l++){
	      rj.set(0,0,0);
	      if(j) rj.vadd(sides[0],rj);
	      else  rj.vsub(sides[0],rj);
	      if(k) rj.vadd(sides[1],rj);
	      else  rj.vsub(sides[1],rj);
	      if(l) rj.vadd(sides[2],rj);
	      else  rj.vsub(sides[2],rj);

	      // World position of corner
	      var sphere_to_corner = xj.vadd(rj).vsub(xi);
	      if(sphere_to_corner.norm()<R){
		found = true;
		var r = makeResult();
		sphere_to_corner.copy(r.ri);
		r.ri.normalize();
		r.ri.copy(r.ni);
		r.ri.mult(R,r.ri);
		rj.copy(r.rj);
		result.push(r);
	      }
	    }
	  }
	}

	// Check edges
	var edgeTangent = new CANNON.Vec3();
	var edgeCenter = new CANNON.Vec3();
	var r = new CANNON.Vec3(); // r = edge center to sphere center
	var orthogonal = new CANNON.Vec3();
	var dist = new CANNON.Vec3();
	for(var j=0; j<sides.length && !found; j++){
	  for(var k=0; k<sides.length && !found; k++){
	    if(j%3!=k%3){
	      // Get edge tangent
	      sides[k].cross(sides[j],edgeTangent);
	      edgeTangent.normalize();
	      sides[j].vadd(sides[k], edgeCenter);
	      xi.copy(r);
	      r.vsub(edgeCenter,r);
	      r.vsub(xj,r);
	      var orthonorm = r.dot(edgeTangent); // distance from edge center to sphere center in the tangent direction
	      edgeTangent.mult(orthonorm,orthogonal); // Vector from edge center to sphere center in the tangent direction
	      
	      // Find the third side orthogonal to this one
	      var l = 0;
	      while(l==j%3 || l==k%3) l++;

	      // vec from edge center to sphere projected to the plane orthogonal to the edge tangent
	      xi.copy(dist);
	      dist.vsub(orthogonal,dist);
	      dist.vsub(edgeCenter,dist);
	      dist.vsub(xj,dist);

	      // Distances in tangent direction and distance in the plane orthogonal to it
	      var tdist = Math.abs(orthonorm);
	      var ndist = dist.norm();
	      
	      if(tdist < sides[l].norm() && ndist<R){
		found = true;
		var res = makeResult();
		edgeCenter.vadd(orthogonal,res.rj); // box rj
		res.rj.copy(res.rj);
		dist.negate(res.ni);
		res.ni.normalize();

		res.rj.copy(res.ri);
		res.ri.vadd(xj,res.ri);
		res.ri.vsub(xi,res.ri);
		res.ri.normalize();
		res.ri.mult(R,res.ri);

		result.push(res);
	      }
	    }
	  }
	}

      } else if(sj.type==CANNON.Shape.types.COMPOUND){ // sphere-compound
	recurseCompound(result,si,sj,xi,xj,qi,qj);
      }
      
    } else if(si.type==CANNON.Shape.types.PLANE){
      
      if(sj.type==CANNON.Shape.types.PLANE){ // plane-plane
	throw "Plane-plane collision... wait, you did WHAT?";
	
      } else if(sj.type==CANNON.Shape.types.BOX){ // plane-box

	// Collision normal
	var n = si.normal.copy();

	// Loop over corners
	var numcontacts = 0;
	var corners = sj.getCorners(qj);
	for(var idx=0; idx<corners.length && numcontacts<=4; idx++){ // max 4 corners against plane
	  var r = makeResult();
	  var worldCorner = corners[idx].vadd(xj);
	  corners[idx].copy(r.rj);

	  // Project down corner to plane to get xj
	  var point_on_plane_to_corner = worldCorner.vsub(xi);
	  var d = n.dot(point_on_plane_to_corner);
	  if(d<=0){
	    numcontacts++;
	    var plane_to_corner = n.mult(d);
	    point_on_plane_to_corner.vsub(plane_to_corner,r.ri);
	    
	    // Set contact normal
	    n.copy(r.ni);
	    
	    // Add contact
	    result.push(r);
	  }
	}
	
      } else if(sj.type==CANNON.Shape.types.COMPOUND){ // plane-compound
	recurseCompound(result,si,sj,xi,xj,qi,qj);
      }
      
    } else if(si.type==CANNON.Shape.types.BOX){
      
      if(sj.type==CANNON.Shape.types.BOX){ // box-box
	throw "box-box collision not implemented yet";
      }
      
      if(sj.type==CANNON.Shape.types.COMPOUND){ // box-compound
	recurseCompound(result,si,sj,xi,xj,qi,qj);
	
      }
      
    } else if(si.type==CANNON.Shape.types.COMPOUND){
      
      if(sj.type==CANNON.Shape.types.COMPOUND){ // compound-compound
	recurseCompound(result,si,sj,xi,xj,qi,qj);
	
      }
    }
    
    // Swap back if we swapped bodies in the beginning
    for(var i=0; swapped && i<result.length; i++)
      swapResult(result[i]);
  }

  // Loop over all collisions
  this.contacts = {}; // Preliminary. contacts["i,j"]=>contact array
  var temp = this.temp;
  for(var k=0; k<p1.length; k++){

    // Get current collision indeces
    var i = p1[k],
      j = p2[k],
      bi = bodies[i],
      bj = bodies[j];
    
    // Check last step stats
    var lastCollisionState = cmatrix(i,j,-1);
    
    // Get collision properties
    var mu = 0.3, e = 0.2;
    var cm = this.getContactMaterial(bi.material,
				     bj.material);
    if(cm){
      mu = cm.friction;
      e = cm.restitution;
    }
    
    // Get contacts
    var contacts = [];
    nearPhase(contacts,
	      bi.shape,
	      bj.shape,
	      bi.position,//new CANNON.Vec3(x[i],y[i],z[i]),
	      bj.position,//new CANNON.Vec3(x[j],y[j],z[j]),
	      bi.quaternion,//new CANNON.Quaternion(qx[i],qy[i],qz[i],qw[i]),
	      bj.quaternion//new CANNON.Quaternion(qx[j],qy[j],qz[j],qw[j])
	      );
    this.contacts[i+","+j] = contacts;

    // Add contact constraint(s)
    for(var ci = 0; ci<contacts.length; ci++){
      var c = contacts[ci];
      
      // g = ( xj + rj - xi - ri ) .dot ( ni )
      var gvec = temp.gvec;
      gvec.set(bj.position.x + c.rj.x - bi.position.x - c.ri.x,
	       bj.position.y + c.rj.y - bi.position.y - c.ri.y,
	       bj.position.z + c.rj.z - bi.position.z - c.ri.z);
      var g = gvec.dot(c.ni); // Gap, negative if penetration

      // Action if penetration
      if(g<0.0){
	var vi = bi.velocity; //temp.vi; vi.set(vx[i],vy[i],vz[i]);
	var wi = bi.angularVelocity; //temp.wi; wi.set(wx[i],wy[i],wz[i]);
	var vj = bj.velocity;//temp.vj; vj.set(vx[j],vy[j],vz[j]);
	var wj = bj.angularVelocity; //temp.wj; wj.set(wx[j],wy[j],wz[j]);

	var n = c.ni;
	var tangents = [temp.t1, temp.t2];
	n.tangents(tangents[0],tangents[1]);

	var v_contact_i = vi.vadd(wi.cross(c.ri));
	var v_contact_j = vj.vadd(wj.cross(c.rj));
	var u_rel = v_contact_j.vsub(v_contact_i);
	var w_rel = wj.cross(c.rj).vsub(wi.cross(c.ri));

	var u = (vj.vsub(vi)); // Contact velo
	var uw = (c.rj.cross(wj)).vsub(c.ri.cross(wi));
	u.vsub(uw,u);

	// Get mass properties
	var iMi = bi.invMass; //world.invm[i];
	var iMj = bj.invMass; //world.invm[j];
	var iIxi = bi.invInertia.x;//world.inertiax[i] > 0 ? 1.0/world.inertiax[i] : 0;
	var iIyi = bi.invInertia.y;//world.inertiay[i] > 0 ? 1.0/world.inertiay[i] : 0;
	var iIzi = bi.invInertia.z;//world.inertiaz[i] > 0 ? 1.0/world.inertiaz[i] : 0;
	var iIxj = bj.invInertia.x;//world.inertiax[j] > 0 ? 1.0/world.inertiax[j] : 0;
	var iIyj = bj.invInertia.y;//world.inertiay[j] > 0 ? 1.0/world.inertiay[j] : 0;
	var iIzj = bj.invInertia.z;//world.inertiaz[j] > 0 ? 1.0/world.inertiaz[j] : 0;

	// Add contact constraint
	var rixn = temp.rixn;
	var rjxn = temp.rjxn;
	c.ri.cross(n,rixn);
	c.rj.cross(n,rjxn);

	var un_rel = n.mult(u_rel.dot(n));
	var u_rixn_rel = rixn.unit().mult(w_rel.dot(rixn.unit()));
	var u_rjxn_rel = rjxn.unit().mult(-w_rel.dot(rjxn.unit()));

	var gn = c.ni.mult(g);

	this.solver
	  .addConstraint( // Non-penetration constraint jacobian
			 [-n.x,-n.y,-n.z,
			  -rixn.x,-rixn.y,-rixn.z,
			  n.x,n.y,n.z,
			  rjxn.x,rjxn.y,rjxn.z],
			 
			 // Inverse mass matrix
			 [iMi,iMi,iMi,
			  iIxi,iIyi,iIzi,
			  iMj,iMj,iMj,
			  iIxj,iIyj,iIzj],
			 
			 // g - constraint violation / gap
			 [-gn.x,-gn.y,-gn.z,
			  0,0,0,//-gn.x,-gn.y,-gn.z,
			  gn.x,gn.y,gn.z,
			  0,0,0//gn.x,gn.y,gn.z
			  ],

			 [-un_rel.x,-un_rel.y,-un_rel.z,
			  0,0,0,//-u_rixn_rel.x,-u_rixn_rel.y,-u_rixn_rel.z,
			  un_rel.x,un_rel.y,un_rel.z,
			  0,0,0//u_rjxn_rel.x,u_rjxn_rel.y,u_rjxn_rel.z
			  ],
			 
			 // External force - forces & torques
			 [bi.force.x,bi.force.y,bi.force.z,
			  bi.tau.x,bi.tau.y,bi.tau.z,
			  bj.force.x,bj.force.y,bj.force.z,
			  bj.tau.x,bj.tau.y,bj.tau.z],
			 0,
			 'inf',
			 i,
			 j);

	// Friction constraints
	if(mu>0.0){
	  var g = that.gravity.norm();
	  for(var ti=0; ti<tangents.length; ti++){
	    var t = tangents[ti];
	    var rixt = c.ri.cross(t);
	    var rjxt = c.rj.cross(t);

	    var ut_rel = t.mult(u_rel.dot(t));
	    var u_rixt_rel = rixt.unit().mult(u_rel.dot(rixt.unit()));
	    var u_rjxt_rel = rjxt.unit().mult(-u_rel.dot(rjxt.unit()));
	    this.solver
	      .addConstraint( // Non-penetration constraint jacobian
			     [-t.x,-t.y,-t.z,
			      -rixt.x,-rixt.y,-rixt.z,
			      t.x,t.y,t.z,
			      rjxt.x,rjxt.y,rjxt.z
			      ],
			     
			     // Inverse mass matrix
			     [iMi,iMi,iMi,
			      iIxi,iIyi,iIzi,
			      iMj,iMj,iMj,
			      iIxj,iIyj,iIzj],
			     
			     // g - constraint violation / gap
			     [0,0,0,
			      0,0,0,
			      0,0,0,
			      0,0,0],
			     
			     [-ut_rel.x,-ut_rel.y,-ut_rel.z,
			      0,0,0,//-u_rixt_rel.x,-u_rixt_rel.y,-u_rixt_rel.z,
			      ut_rel.x,ut_rel.y,ut_rel.z,
			      0,0,0//u_rjxt_rel.x,u_rjxt_rel.y,u_rjxt_rel.z
			      ],
			     
			     // External force - forces & torques
			     [bi.force.x,bi.force.y,bi.force.z,
			      bi.tau.x,bi.tau.y,bi.tau.z,
			      bj.force.x,bj.force.y,bj.force.z,
			      bj.tau.x,bj.tau.y,bj.tau.z],
			     
			     -mu*g*(bi.mass+bj.mass),
			     mu*g*(bi.mass+bj.mass),

			     i,
			     j);
	  }
	}
      }
    }
  }

  if(this.solver.n){
    this.solver.solve();

    // Apply constraint velocities
    for(var i in bodies){
      var b = bodies[i];
      b.velocity.x += this.solver.vxlambda[i];
      b.velocity.y += this.solver.vylambda[i];
      b.velocity.z += this.solver.vzlambda[i];
      b.angularVelocity.x += this.solver.wxlambda[i];
      b.angularVelocity.y += this.solver.wylambda[i];
      b.angularVelocity.z += this.solver.wzlambda[i];
    }
  }

  // Apply damping
  for(var i in bodies){
    var ld = 1.0 - bodies[i].linearDamping;
    var ad = 1.0 - bodies[i].angularDamping;
    bodies[i].velocity.mult(ld,bodies[i].velocity);
    bodies[i].angularVelocity.mult(ad,bodies[i].angularVelocity);
  }

  // Leap frog
  // vnew = v + h*f/m
  // xnew = x + h*vnew
  var q = temp.step_q; 
  var w = temp.step_w;
  var wq = temp.step_wq;
  for(var i in bodies){
    var b = bodies[i];
    if(!b.fixed){
      
      b.velocity.x += b.force.x * b.invMass * dt;
      b.velocity.y += b.force.y * b.invMass * dt;
      b.velocity.z += b.force.z * b.invMass * dt;

      b.angularVelocity.x += b.tau.x * b.invInertia.x * dt;
      b.angularVelocity.y += b.tau.y * b.invInertia.y * dt;
      b.angularVelocity.z += b.tau.z * b.invInertia.z * dt;

      // Use new velocity  - leap frog
      
      b.position.x += b.velocity.x * dt;
      b.position.y += b.velocity.y * dt;
      b.position.z += b.velocity.z * dt;

      w.set(b.angularVelocity.x,
	    b.angularVelocity.y,
	    b.angularVelocity.z,
	    0);
      w.mult(b.quaternion,wq);

      b.quaternion.x += dt * 0.5 * wq.x;
      b.quaternion.y += dt * 0.5 * wq.y;
      b.quaternion.z += dt * 0.5 * wq.z;
      b.quaternion.w += dt * 0.5 * wq.w;
      b.quaternion.normalize();
    }
    b.force.set(0,0,0);
    b.tau.set(0,0,0);
  }

  // Update world time
  world.time += dt;
  world.stepnumber += 1;
};

