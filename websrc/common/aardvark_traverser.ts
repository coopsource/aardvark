import { MsgUpdateSceneGraph, EndpointType, MsgGrabEvent } from 'common/aardvark-react/aardvark_protocol';
import { CRendererEndpoint } from './aardvark-react/renderer_endpoint';
import { Av, AvGrabEventType } from 'common/aardvark';
import { AvModelInstance, AvNode, AvNodeRoot, AvNodeType, AvVisualFrame, EHand, EVolumeType, AvGrabEvent } from './aardvark';
import { mat4, vec3, quat, vec4 } from '@tlaukkan/tsm';
import bind from 'bind-decorator';
import { EndpointAddr, endpointAddrToString, endpointAddrIsEmpty, MessageType } from './aardvark-react/aardvark_protocol';

interface NodeData
{
	lastModelUri?: string;
	modelInstance?: AvModelInstance;
}

function translateMat( t: vec3)
{
	let m = new mat4();
	m.setIdentity();
	m.translate( t );
	return m;
}

function scaleMat( s: vec3)
{
	let m = new mat4();
	m.setIdentity();
	m.scale( s );
	return m;
}


class PendingTransform
{
	private m_needsUpdate = true;
	private m_parent: PendingTransform = null;
	private m_parentFromNode: mat4 = null;
	private m_universeFromNode: mat4 = null;
	private m_applyFunction: (universeFromNode: mat4) => void = null;
	private m_currentlyResolving = false;

	public resolve()
	{
		if( this.m_universeFromNode )
		{
			return;
		}

		if( this.m_needsUpdate )
		{
			console.log( "Pending transform needs an update in resolve");
			this.m_parentFromNode = mat4.identity;
		}
		
		if( this.m_currentlyResolving )
		{
			throw "Loop in pending transform parents";
		}

		this.m_currentlyResolving = true;

		if( this.m_parent )
		{
			this.m_parent.resolve();
			this.m_universeFromNode = new mat4;
			mat4.product( this.m_parent.m_universeFromNode, this.m_parentFromNode, this.m_universeFromNode );
		}
		else
		{
			this.m_universeFromNode = this.m_parentFromNode;
		}

		this.m_currentlyResolving = false;

		if( this.m_applyFunction )
		{
			this.m_applyFunction( this.m_universeFromNode );
		}

	}

	public getUniverseFromNode():mat4
	{
		return this.m_universeFromNode;
	}
	public needsUpdate(): boolean
	{
		return this.m_needsUpdate;
	}
	public update( parent: PendingTransform, parentFromNode: mat4, updateCallback?: ( universeFromNode:mat4 ) => void )
	{
		this.m_needsUpdate = false;
		this.m_parent = parent;
		this.m_parentFromNode = parentFromNode ? parentFromNode : mat4.identity;
		this.m_applyFunction = updateCallback;

		this.checkForLoops();
	}

	private checkForLoops()
	{
		for( let test = this.m_parent; test != null; test = test.m_parent )
		{
			if( test == this )
			{
				throw "Somebody created a loop in transform parents";
			}
		}
	}
}


interface NodeToNodeAnchor_t
{
	parentGlobalId: EndpointAddr;
	parentFromNodeTransform: mat4;
}

export class AvDefaultTraverser
{
	private m_inFrameTraversal = false;
	private m_handDeviceForNode: { [nodeGlobalId:string]:EHand } = {};
	private m_currentHand = EHand.Invalid;
	private m_currentGrabbableGlobalId:EndpointAddr = null;
	private m_universeFromNodeTransforms: { [ nodeGlobalId:string ]: PendingTransform } = {};
	private m_nodeData: { [ nodeGlobalId:string ]: NodeData } = {};
	private m_lastFrameUniverseFromNodeTransforms: { [ nodeGlobalId:string ]: mat4 } = {};
	private m_roots: { [gadgetId:number] : AvNodeRoot } = {};
	private m_currentRoot: AvNodeRoot = null;
	private m_renderList: AvModelInstance[] = [];
	private m_nodeToNodeAnchors: { [ nodeGlobalId: string ]: NodeToNodeAnchor_t } = {};
	private m_endpoint: CRendererEndpoint = null;

	constructor()
	{
		this.m_endpoint = new CRendererEndpoint( this.onEndpointOpen );
		this.m_endpoint.registerHandler( MessageType.UpdateSceneGraph, this.onUpdateSceneGraph )
		this.m_endpoint.registerHandler( MessageType.GrabEvent, 
			( type: MessageType, m: MsgGrabEvent ) =>
			{
				this.grabEvent( m.event );
			} );
	}

	@bind onEndpointOpen()
	{

	}

	@bind onUpdateSceneGraph( type:MessageType, payload: any, sender: EndpointAddr )
	{
		let m = payload as MsgUpdateSceneGraph;
		if( !m.root )
		{
			// TODO: Clean up drags and such?
			delete this.m_roots[ sender.endpointId ];
		}
		else
		{
			this.updateGlobalIds( m.root, sender.endpointId );
			this.m_roots[ sender.endpointId ] =
			{
				gadgetId: sender.endpointId,
				root: m.root,
				hook: m.hook,
			}
		}
	}

	private updateGlobalIds( node: AvNode, gadgetId: number )
	{
		node.globalId =
		{
			type: EndpointType.Node,
			endpointId: gadgetId,
			nodeId: node.id,
		}

		if( node.children )
		{
			for( let child of node.children )
			{
				this.updateGlobalIds( child, gadgetId );
			}
		}
	}

	@bind
	public traverse()
	{
		if( !this.m_roots )
		{
			return;
		}

		this.m_inFrameTraversal = true;
		this.m_handDeviceForNode = {};
		//m_intersections.reset();
		//m_collisions.reset();
		this.m_currentHand = EHand.Invalid;
		this.m_currentGrabbableGlobalId = null;
		this.m_universeFromNodeTransforms = {};
		this.m_renderList = [];

		for ( let gadgetId in this.m_roots )
		{
			this.traverseSceneGraph( this.m_roots[ gadgetId ] );
		}
		this.m_currentRoot = null;
	
		this.m_lastFrameUniverseFromNodeTransforms = {};
		for ( let nodeGlobalId in this.m_universeFromNodeTransforms )
		{
			let transform = this.m_universeFromNodeTransforms[ nodeGlobalId ];
			transform.resolve();
			this.m_lastFrameUniverseFromNodeTransforms[ nodeGlobalId] = transform.getUniverseFromNode();
		}
	
		this.m_inFrameTraversal = false;
	
		// m_intersections.updatePokerProximity( m_client );

		Av().renderer.renderList( this.m_renderList );

		this.updateGrabberIntersections();
	}

	private updateGrabberIntersections()
	{
		let states = Av().renderer.updateGrabberIntersections();
		for( let state of states )
		{
			this.m_endpoint.sendMessage( MessageType.GrabberState, state );
		}
	}

	getNodeData( node: AvNode ): NodeData
	{
		let nodeIdStr = endpointAddrToString( node.globalId );
		if( !this.m_nodeData.hasOwnProperty( nodeIdStr ) )
		{
			this.m_nodeData[ nodeIdStr] = {};
		}
		return this.m_nodeData[ nodeIdStr ];
	}

	traverseSceneGraph( root: AvNodeRoot ): void
	{
		if( root.root )
		{
			// get the ID for node 0. We're going to use that as the parent of
			// everything. 
			let rootNode: AvNode;
			if( root.root.id == 0 )
			{
				rootNode = root.root;
			}
			else
			{
				rootNode = 
				{
					type: AvNodeType.Container,
					id: 0,
					flags: 0,
					globalId: { type: EndpointType.Node, endpointId: root.root.globalId.endpointId, nodeId: 0 },
					children: [ root.root ],
				}
			}

			this.m_currentRoot = root;
			if( root.hook )
			{
				this.setHookOrigin( root.hook, rootNode );
			}

			this.traverseNode( rootNode, null );
		}
	}

	traverseNode( node: AvNode, defaultParent: PendingTransform ): void
	{
		let handBefore = this.m_currentHand;

		switch ( node.type )
		{
		case AvNodeType.Container:
			// nothing special to do here
			break;

		case AvNodeType.Origin:
			this.traverseOrigin( node, defaultParent );
			break;

		case AvNodeType.Transform:
			this.traverseTransform( node, defaultParent );
			break;

		case AvNodeType.Model:
			this.traverseModel( node, defaultParent );
			break;

		case AvNodeType.Panel:
			this.traversePanel( node, defaultParent );
			break;

		case AvNodeType.Poker:
			this.traversePoker( node, defaultParent );
			break;

		case AvNodeType.Grabbable:
			this.traverseGrabbable( node, defaultParent );
			break;

		case AvNodeType.Handle:
			this.traverseHandle( node, defaultParent );
			break;

		case AvNodeType.Grabber:
			this.traverseGrabber( node, defaultParent );
			break;

		case AvNodeType.Hook:
			this.traverseHook( node, defaultParent );
			break;
		
		default:
			throw "Invalid node type";
		}

		let thisNodeTransform = this.getTransform( node.globalId );
		if ( thisNodeTransform.needsUpdate() )
		{
			thisNodeTransform.update( defaultParent, mat4.identity );
		}

		this.m_handDeviceForNode[ endpointAddrToString( node.globalId ) ] = this.m_currentHand;

		if( node.children )
		{
			for ( let child of node.children )
			{
				this.traverseNode( child, thisNodeTransform );
			}
		}

		if ( node.type == AvNodeType.Grabbable )
		{
			this.m_currentGrabbableGlobalId = null;
		}

		this.m_currentHand = handBefore;
	}


	traverseOrigin( node: AvNode, defaultParent: PendingTransform )
	{
		this.setHookOrigin( node.propOrigin, node );
	}


	setHookOrigin( origin: string, node: AvNode )
	{
		let universeFromOrigin = Av().renderer.getUniverseFromOriginTransform( origin );
		if ( universeFromOrigin )
		{
			this.updateTransform( node.globalId, null, new mat4( universeFromOrigin ), null );

			if ( origin == "/user/hand/left" )
			{
				this.m_currentHand = EHand.Left;
			}
			else if ( origin == "/user/hand/right" )
			{
				this.m_currentHand = EHand.Right;
			}
			else
			{
				this.m_currentHand = EHand.Invalid;
			}
		}
	}

	traverseTransform( node: AvNode, defaultParent: PendingTransform )
	{
		if ( node.propTransform )
		{
			let transform = node.propTransform;

			let vTrans: vec3;
			if ( transform.position )
			{
				vTrans = new vec3( [ transform.position.x, transform.position.y, transform.position.z ] );
			}
			else
			{
				vTrans = new vec3( [ 0, 0, 0 ] );
			}
			let vScale: vec3;
			if ( transform.scale )
			{
				vScale = new vec3( [ transform.scale.x, transform.scale.y, transform.scale.z ] );
			}
			else
			{
				vScale = new vec3( [ 1, 1, 1 ] );
			}
			let qRot: quat;
			if ( transform.rotation )
			{
				qRot = new quat( [ transform.rotation.x, transform.rotation.y, transform.rotation.z, transform.rotation.w ] );
			}
			else
			{
				qRot = new quat( [ 0, 0, 0, 1 ] );
			}

			let mat = translateMat( vTrans ).multiply( qRot.toMat4() );
			mat = mat.multiply( scaleMat( vScale ) ) ;
			this.updateTransform( node.globalId, defaultParent, mat, null );
		}
	}

	traverseModel( node: AvNode, defaultParent: PendingTransform )
	{
		let nodeData = this.getNodeData( node );

		if ( nodeData.lastModelUri != node.propModelUri )
		{
			nodeData.modelInstance = null;
		}

		if ( !nodeData.modelInstance )
		{
			nodeData.modelInstance = Av().renderer.createModelInstance( node.propModelUri );
			if ( nodeData.modelInstance )
			{
				nodeData.lastModelUri = node.propModelUri;
			}
		}

		if ( nodeData.modelInstance )
		{
			this.updateTransform( node.globalId, defaultParent, mat4.identity,
				( universeFromNode: mat4 ) =>
			{
				nodeData.modelInstance.setUniverseFromModelTransform( universeFromNode.all() );
				this.m_renderList.push( nodeData.modelInstance );
			} );
		}
	}

	traversePanel( node: AvNode, defaultParent: PendingTransform )
	{
		let nodeData = this.getNodeData( node );

		// if we don't have shared texture info for this panel yet, there's
		// nothing to do here
		if( !node.propSharedTexture )
			return;

		let textureInfo = node.propSharedTexture;

		if ( !nodeData.modelInstance )
		{
			let sPanelModelUri = "https://aardvark.install/models/panel/panel.glb";
			if( textureInfo.invertY )
			{
				sPanelModelUri = "https://aardvark.install/models/panel/panel_inverted.glb";
			}

			nodeData.modelInstance = Av().renderer.createModelInstance( sPanelModelUri );
		}

		if ( nodeData.modelInstance )
		{
			try
			{
				nodeData.modelInstance.setOverrideTexture( textureInfo );
			}
			catch( e )
			{
				// just eat these and don't add the panel. Sometimes we find out about a panel 
				// before we find out about its texture
				return;
			}

			let hand = this.m_currentHand;
			this.updateTransform( node.globalId, defaultParent, mat4.identity,
				( universeFromNode: mat4 ) =>
			{
				nodeData.modelInstance.setUniverseFromModelTransform( universeFromNode.all() );
				this.m_renderList.push( nodeData.modelInstance );

				if ( node.propInteractive )
				{
					let panelNormal = universeFromNode.multiplyVec4( new vec4( [ 0, 1, 0, 0 ] ) );
					let zScale = panelNormal.length();
					let nodeFromUniverse = new mat4( universeFromNode.all() ).inverse();
					Av().renderer.addActivePanel(
						endpointAddrToString( node.globalId ),
						nodeFromUniverse.all(),
						zScale, 
						hand );
				}
			} );
		}
	}

	traversePoker( node: AvNode, defaultParent: PendingTransform )
	{
		let hand = this.m_currentHand;
		this.updateTransform( node.globalId, defaultParent, null,
			( universeFromNode: mat4 ) =>
		{
			let pokerInUniverse = universeFromNode.multiplyVec4( new vec4( [ 0, 0, 0, 1 ] ) );
			Av().renderer.addActivePoker( endpointAddrToString( node.globalId ), [ pokerInUniverse.x, pokerInUniverse.y, pokerInUniverse.z ], hand );
		} );
	}
	
	traverseGrabbable( node: AvNode, defaultParent: PendingTransform )
	{
		this.m_currentGrabbableGlobalId = node.globalId;
		let nodeIdStr = endpointAddrToString( node.globalId );
		if( this.m_nodeToNodeAnchors.hasOwnProperty( nodeIdStr ) )
		{
			let anchor = this.m_nodeToNodeAnchors[ nodeIdStr ];
			let parentTransform = this.getTransform( anchor.parentGlobalId );
			this.updateTransform( node.globalId, parentTransform, anchor.parentFromNodeTransform, null );
		}
	}
	
	traverseHandle( node: AvNode, defaultParent: PendingTransform )
	{
		if ( !node.propVolume )
		{
			return;
		}
	
		let grabbableGlobalId = this.m_currentGrabbableGlobalId;
		let hand = this.m_currentHand;
		this.updateTransform( node.globalId, defaultParent, null,
			( universeFromNode: mat4 ) =>
		{
			switch( node.propVolume.type )
			{
				case EVolumeType.Sphere:
					Av().renderer.addGrabbableHandle_Sphere( grabbableGlobalId, universeFromNode.all(), 
						node.propVolume.radius, hand );
					break;
				default:
					throw "unsupported volume type";
			}
		} );
	}

	traverseGrabber(node: AvNode, defaultParent: PendingTransform )
	{
		if ( !node.propVolume )
		{
			return;
		}

		let grabberGlobalId = node.globalId;
		let grabberHand = this.m_currentHand;
		this.updateTransform( node.globalId, defaultParent, null,
			( universeFromNode: mat4 ) =>
		{
			let nodeFromUniverse = new mat4( universeFromNode.all() ).inverse();
			switch( node.propVolume.type )
			{
				case EVolumeType.Sphere:
					Av().renderer.addGrabber_Sphere( grabberGlobalId, nodeFromUniverse.all(), 
						node.propVolume.radius, grabberHand );
					break;
				default:
					throw "unsupported volume type";
			}
		} );
	}

	traverseHook( node: AvNode, defaultParent: PendingTransform )
	{
		if( !node.propVolume )
		{
			return;
		}

		let hookGlobalId = node.globalId;
		let hand = this.m_currentHand;
		this.updateTransform( node.globalId, defaultParent, null,
			( universeFromNode: mat4 ) =>
		{
			switch( node.propVolume.type )
			{
				case EVolumeType.Sphere:
					Av().renderer.addHook_Sphere( hookGlobalId, universeFromNode.all(), node.propVolume.radius, hand );
					break;
				default:
					throw "unsupported volume type";
			}
		} );
	}

	@bind
	public grabEvent( grabEvent: AvGrabEvent )
	{
		switch( grabEvent.type )
		{
			case AvGrabEventType.StartGrab:
				console.log( "Traverser starting grab of " + grabEvent.grabbableId + " by " + grabEvent.grabberId );

				let grabberIdStr = endpointAddrToString( grabEvent.grabberId );
				let grabbableIdStr = endpointAddrToString( grabEvent.grabbableId );
				if( !this.m_lastFrameUniverseFromNodeTransforms.hasOwnProperty( grabberIdStr ) )
				{
					throw "grabber wasn't rendered last frame";
				}

				let grabberFromGrabbable: mat4;
				if( !this.m_lastFrameUniverseFromNodeTransforms.hasOwnProperty( grabbableIdStr  ) 
					|| grabEvent.useIdentityTransform )
				{
					grabberFromGrabbable = mat4.identity;
				}
				else
				{
					let universeFromGrabbable = this.m_lastFrameUniverseFromNodeTransforms[ grabbableIdStr ];
					let grabberFromUniverse = this.m_lastFrameUniverseFromNodeTransforms[ grabberIdStr ].inverse();
		
					grabberFromGrabbable = grabberFromUniverse.multiply( universeFromGrabbable );
				}
		
				this.m_nodeToNodeAnchors[ grabbableIdStr ] = 
				{
					parentGlobalId: grabEvent.grabberId,
					parentFromNodeTransform: grabberFromGrabbable,
				};
				Av().renderer.startGrab( grabEvent.grabberId, grabEvent.grabbableId );

				this.m_endpoint.sendGrabEvent( 
					{
						type: AvGrabEventType.GrabStarted,
						grabberId: grabEvent.grabberId,
						grabbableId: grabEvent.grabbableId,
					}
				);
				break;

			case AvGrabEventType.EndGrab:
				console.log( "Traverser ending grab of " + grabEvent.grabbableId + " by " + grabEvent.grabberId );
				Av().renderer.endGrab( grabEvent.grabberId, grabEvent.grabbableId );
				if( !endpointAddrIsEmpty( grabEvent.hookId ) )
				{
					// we're dropping onto a hook
					this.m_nodeToNodeAnchors[ endpointAddrToString( grabEvent.grabbableId ) ] = 
					{
						parentGlobalId: grabEvent.hookId,
						parentFromNodeTransform: null,
					};
				}
				else
				{
					// we're dropping into open space
					delete this.m_nodeToNodeAnchors[ endpointAddrToString( grabEvent.grabbableId ) ];
				}
				break;
		}
	}

	getTransform( globalNodeId: EndpointAddr  ): PendingTransform
	{
		let idStr = endpointAddrToString( globalNodeId );
		if( idStr == "0" )
			return null;

		if( !this.m_universeFromNodeTransforms.hasOwnProperty( idStr ) )
		{
			this.m_universeFromNodeTransforms[ idStr ] = new PendingTransform();
		}
		return this.m_universeFromNodeTransforms[ idStr ];
	}

	updateTransform( globalNodeId: EndpointAddr,
		parent: PendingTransform, parentFromNode: mat4,
		applyFunction: ( universeFromNode: mat4 ) => void )
	{
		let transform = this.getTransform( globalNodeId );
		transform.update( parent, parentFromNode, applyFunction );
		return transform;
	}

	
	@bind
	public sendHapticEventForNode( targetGlobalNodeId: string, amplitude: number, frequency: number, duration: number )
	{
		let hapticHand = this.m_handDeviceForNode[ targetGlobalNodeId ];
		if( hapticHand )
		{
			Av().renderer.sendHapticEventForHand( hapticHand, amplitude, frequency, duration );

		}
	}

	@bind
	public newSceneGraph( frame: AvVisualFrame )
	{
		if( this.m_inFrameTraversal )
		{
			throw "Received a new scene graph during traversal";
		}
//		console.log( "New scene graph frame " + frame.id );
		if( frame.nodeRoots == undefined )
		{
			console.log( "roots were undefined");
			return;
		}

		this.m_roots = frame.nodeRoots;
	}
}


