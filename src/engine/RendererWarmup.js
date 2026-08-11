import * as THREE from 'three';

const PASS_PROPERTIES = [
    [ 'scene', 'camera' ],
    [ 'fadeScene', 'fadeCamera' ],
    [ 'distortionScene', 'distortionCamera' ],
    [ 'downsampleScene', 'blurCamera' ],
    [ 'blurScene', 'blurCamera' ],
    [ 'outputScene', 'outputCamera' ],
    [ 'blendScene', 'blendCamera' ],
    [ 'copyScene', 'copyCamera' ],
    [ 'crossfadeScene', 'copyCamera' ]
];

const RENDER_TARGET_PROPERTIES = [
    'blurRenderTarget',
    'accumulationRenderTarget',
    'tempRenderTarget',
    'crossfadeRenderTarget'
];

const DYNAMIC_MAP_MATERIAL_PROPERTIES = [
    'outputMaterial',
    'copyMaterial',
    'crossfadeMaterial'
];

const COMPILE_TARGET_COUNT = 2;

function addPass( passes, seen, scene, camera, usesFog = false ) {

    if ( ! scene?.isObject3D || ! camera?.isCamera ) return;

    let cameras = seen.get( scene );

    if ( ! cameras ) {

        cameras = new Set();
        seen.set( scene, cameras );

    }

    if ( cameras.has( camera ) ) return;

    cameras.add( camera );
    passes.push( { scene, camera, usesFog } );

}

function collectWarmupPasses( effects, defaultCamera ) {

    const passes = [];
    const seen = new Map();

    for ( const effect of effects ) {

        if ( effect.maxScene ) {

            addPass(
                passes,
                seen,
                effect.scene,
                effect.maxScene.activeCamera || defaultCamera,
                true
            );

        }

        for ( const [ sceneProperty, cameraProperty ] of PASS_PROPERTIES ) {

            addPass(
                passes,
                seen,
                effect[ sceneProperty ],
                effect[ cameraProperty ] || defaultCamera
            );

        }

    }

    return passes;

}

function collectRenderTargets( effects, contentRenderTarget ) {

    const targets = new Set();

    if ( contentRenderTarget ) targets.add( contentRenderTarget );

    for ( const effect of effects ) {

        for ( const property of RENDER_TARGET_PROPERTIES ) {

            const target = effect[ property ];
            if ( target?.isWebGLRenderTarget ) targets.add( target );

        }

        for ( const target of effect.blurPyramidRenderTargets || [] ) {

            if ( target?.isWebGLRenderTarget ) targets.add( target );

        }

    }

    return [ ...targets ];

}

function seedDynamicTextureMaterials( effects, texture ) {

    // A null map selects MeshBasicMaterial's untextured program. Keep this map
    // after warm-up so later texture swaps retain the compiled textured variant.
    for ( const effect of effects ) {

        for ( const property of DYNAMIC_MAP_MATERIAL_PROPERTIES ) {

            const material = effect[ property ];

            if ( material?.isMeshBasicMaterial && material.map === null ) {

                material.map = texture;
                material.needsUpdate = true;

            }

        }

    }

}

function uploadGeometry( renderer, scene, camera ) {

    const objectStates = [];

    // compileAsync() visits hidden objects but deliberately does not create
    // their vertex/index GPU buffers. Make every drawable reachable for one
    // 1x1 offscreen render, then restore the authored visibility exactly.
    scene.traverse( object => {

        objectStates.push( {
            object,
            visible: object.visible,
            frustumCulled: object.frustumCulled
        } );
        object.visible = true;

        if ( object.isMesh || object.isPoints || object.isLine || object.isSprite ) {

            object.frustumCulled = false;

        }

    } );

    try {

        renderer.render( scene, camera );

    } finally {

        for ( const state of objectStates ) {

            state.object.visible = state.visible;
            state.object.frustumCulled = state.frustumCulled;

        }

    }

}

/**
 * Upload the decoded images, allocate render targets, and compile every program
 * variant used by the demo while the launcher is still visible. WebGL normally
 * defers all three until first use, which otherwise stalls scene transitions.
 */
export async function warmupRenderer( {
    renderer,
    effects,
    textureLoader,
    defaultCamera,
    contentRenderTarget,
    onProgress = null
} ) {

    const effectList = [ ...effects ];
    seedDynamicTextureMaterials( effectList, contentRenderTarget.texture );

    const textures = [ ...new Set( textureLoader.textureCache.values() ) ];
    const renderTargets = collectRenderTargets( effectList, contentRenderTarget );
    const passes = collectWarmupPasses( effectList, defaultCamera );
    const compileSteps = passes.reduce(
        ( total, pass ) => total + COMPILE_TARGET_COUNT * ( pass.usesFog ? 2 : 1 ) + 1,
        0
    );
    const total = textures.length + renderTargets.length + compileSteps;
    let completed = 0;

    const reportProgress = () => {

        completed ++;
        onProgress?.( completed, total );

    };

    const previousTarget = renderer.getRenderTarget();
    const previousViewport = renderer.getViewport( new THREE.Vector4() );
    const previousScissor = renderer.getScissor( new THREE.Vector4() );
    const previousScissorTest = renderer.getScissorTest();
    const supportsParallelCompile = renderer.getContext()
        .getExtension( 'KHR_parallel_shader_compile' ) !== null;
    const warmupFog = new THREE.Fog( 0x000000, 1, 1000 );
    const warmupTarget = new THREE.WebGLRenderTarget( 1, 1, {
        depthBuffer: true,
        stencilBuffer: false
    } );

    try {

        for ( const texture of textures ) {

            renderer.initTexture( texture );
            reportProgress();

        }

        for ( const target of renderTargets ) {

            renderer.initRenderTarget( target );
            reportProgress();

        }

        renderer.initRenderTarget( warmupTarget );

        // Compile once for the offscreen legacy framebuffer and once for the
        // canvas. The latter covers title/credit layers rendered above FILTER.
        const targets = [ warmupTarget, null ];

        for ( const pass of passes ) {

            const previousFog = pass.scene.fog;
            const fogVariants = pass.usesFog ? [ null, warmupFog ] : [ previousFog ];

            try {

                for ( const fog of fogVariants ) {

                    pass.scene.fog = fog;

                    for ( const target of targets ) {

                        renderer.setRenderTarget( target );
                        if ( supportsParallelCompile ) {

                            await renderer.compileAsync( pass.scene, pass.camera );

                        } else {

                            // Fixed-function-era content still benefits from a
                            // synchronous warm-up on implementations without
                            // the optional parallel-compile extension.
                            renderer.compile( pass.scene, pass.camera );

                        }
                        reportProgress();

                    }

                }

                pass.scene.fog = previousFog;
                renderer.setRenderTarget( warmupTarget );
                uploadGeometry( renderer, pass.scene, pass.camera );
                reportProgress();

            } finally {

                pass.scene.fog = previousFog;

            }

        }

    } finally {

        renderer.setRenderTarget( previousTarget );
        renderer.setViewport( previousViewport );
        renderer.setScissor( previousScissor );
        renderer.setScissorTest( previousScissorTest );
        warmupTarget.dispose();

    }

}
