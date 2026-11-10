let board;
let led;
let button;
let state = 0;
let potentiometer;

function setup() {
    createCanvas(500, 500);
    board = createBoard();
    createConnectButton(board);
    
    led = new five.Led(3);

    button = new five.Button({ pin: 7, isPullup: true });

    button.on("press", function(){
        state = state == 0 ? 1 : 0;
        console.log(`state ${state}`)
    })

    button.on("hold", function(ms){
          console.log(`hold for ${ms} milliseconds`);
        });
    // potentiometer = new five.Sensor("A0");  

    // sensor.on("change", function() {
    //     console.log(this.scaleTo(0, 10));
    // });
        
}



function draw() {
    background(200);

    console.log(state)

    if(button.isDown){
        background(100);

    }else{
        background(255);

    }



    // if(mouseX < 100){
    //     led.off();

    // }else if(mouseX > 100 & mouseX < 300){
    //     led.blink(1000);
    // }else{
    //     led.stop();
    // }

    // text(potentiometer.value, 10, 10);
    // console.log(potentiometer)

    // let mV = map(potentiometer, 0, 1023, 0, width);
    // circle(width/2, height/2, mV);

    // if(mouseY > height/2){
    //     led.on();
    // }else{
    //     led.off();
    // }
}

// function sensorChanged(s){
//     console.log(s.value);
// }